import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, TASK_EXPIRY_MS } from "../src/http.js";
import { ProcessManager } from "../src/process-manager.js";
import { ModInstaller } from "../src/mod-installer.js";
import { ModRegistry } from "../src/mod-registry.js";
import { SteamCmd } from "../src/steamcmd.js";
import { SteamWorkshop } from "../src/steam-workshop.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { makeFakeSpawn } from "./fixtures/fake-spawn.js";
import { makeFakeFetch, detailsBody, type FakeFetch } from "./fixtures/fake-fetch.js";
import type { DaemonConfig, WsMessage } from "../src/types.js";
import * as F from "./fixtures/log-fixtures.js";
import { makeWorldZip, WORLD_SETTINGS_CFG } from "./fixtures/world-zip.js";
import { openWorldSettings } from "../src/world-settings.js";
/** What `app.inject` resolves to; naming it lets a helper declare its own return type. */
import type { Response as Injected } from "light-my-request";

/** Never a real key; the injected fetch means it is never sent anywhere either. */
const FAKE_KEY = "0000000000000000000000000000TEST";

let cfg: DaemonConfig;
let configFile: string;
let spawn: ReturnType<typeof makeFakeSpawn>;
let pm: ProcessManager;
let installer: ModInstaller;
let registry: ModRegistry;
let steam: SteamCmd;
let net: FakeFetch;
let workshop: SteamWorkshop;
let app: ReturnType<typeof buildServer>;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "necesse-http-"));
  const modsDir = join(root, "mods");
  const worldsDir = join(root, "worlds");
  await mkdir(modsDir, { recursive: true });
  await mkdir(worldsDir, { recursive: true });
  await writeFile(join(worldsDir, "Tulsa.zip"), "x");
  cfg = { ...DEFAULT_CONFIG, modsDir, worldsDir, stopTimeoutMs: 50 };
  configFile = join(root, "config.json");
  spawn = makeFakeSpawn();
  pm = new ProcessManager(cfg, spawn.spawn);
  steam = new SteamCmd(cfg, spawn.spawn);
  registry = new ModRegistry(join(root, "mods.json"));
  installer = new ModInstaller(cfg, registry, steam);
  net = makeFakeFetch();
  workshop = new SteamWorkshop(cfg, net.fetch);
  app = buildServer({ cfg, configFile, pm, installer, steam, workshop });
});

describe("GET /api/status", () => {
  it("reports stopped initially", async () => {
    const res = await app.inject({ method: "GET", url: "/api/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("stopped");
  });

  it("self-heals a stale unmanaged state when the external pid is gone", async () => {
    const esrch = (): never => {
      const e = new Error("kill ESRCH") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    };
    const deadPm = new ProcessManager(cfg, spawn.spawn, esrch);
    deadPm.markUnmanaged(9001);
    const selfHealApp = buildServer({ cfg, configFile, pm: deadPm, installer, steam, workshop });

    const res = await selfHealApp.inject({ method: "GET", url: "/api/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("stopped");
    expect(res.json().pid).toBeNull();
  });
});

// The daemon is the authority on what is in flight: it is the only party that
// sees both a task's acceptance and its completion. These pin the lifecycle of
// that set on every exit path, plus the server-side interlock that stops a
// second client (or curl, or a page left open) from launching the game while
// steamcmd is rewriting the install.
describe("activeTasks in the status payload", () => {
  it("is empty with nothing running", async () => {
    const res = await app.inject({ method: "GET", url: "/api/status" });
    expect(res.json().activeTasks).toEqual([]);
  });

  it("lists an accepted task's id until the task finishes", async () => {
    const launch = await app.inject({ method: "POST", url: "/api/server/update" });
    const { taskId } = launch.json();

    const during = await app.inject({ method: "GET", url: "/api/status" });
    expect(during.json().activeTasks).toEqual([taskId]);

    // steamcmd exits; the task settles.
    spawn.calls[0].child.exit(0);
    await vi.waitFor(async () => {
      const after = await app.inject({ method: "GET", url: "/api/status" });
      expect(after.json().activeTasks).toEqual([]);
    });
  });

  it("clears the entry when the task's own promise rejects", async () => {
    // A task whose underlying work throws must not leak an entry - a leak
    // wedges Start for the whole life of the daemon.
    const throwingSteam = {
      updateApp: () => Promise.reject(new Error("steamcmd is missing")),
    } as unknown as SteamCmd;
    const rejectApp = buildServer({
      cfg,
      configFile,
      pm,
      installer,
      steam: throwingSteam,
      workshop,
    });

    const launch = await rejectApp.inject({ method: "POST", url: "/api/server/update" });
    expect(launch.json().ok).toBe(true);

    await vi.waitFor(async () => {
      const res = await rejectApp.inject({ method: "GET", url: "/api/status" });
      expect(res.json().activeTasks).toEqual([]);
    });
  });

  it("refuses to start a second task while one is active, rather than interleaving them", async () => {
    // Two steamcmd runs rewriting serverRoot/modsDir at once is the hazard;
    // these operations serialize instead. Every task-launching route, plus
    // the mod delete that writes the same folder, must refuse.
    const first = (await app.inject({ method: "POST", url: "/api/server/update" })).json().taskId;

    for (const [method, url, payload] of [
      ["POST", "/api/server/update", undefined],
      ["POST", "/api/mods", { id: "123", name: "A" }],
      ["POST", "/api/mods/update-all", undefined],
      ["DELETE", "/api/mods/123", undefined],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json().error, `${method} ${url}`).toMatch(/background task/i);
    }
    // Only the original steamcmd was ever spawned.
    expect(spawn.calls).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([first]);

    spawn.calls[0].child.exit(0);
    await vi.waitFor(async () => {
      const res = await app.inject({ method: "GET", url: "/api/status" });
      expect(res.json().activeTasks).toEqual([]);
    });

    // ...and the next task is accepted normally once the first has cleared.
    const second = await app.inject({ method: "POST", url: "/api/mods/update-all" });
    expect(second.statusCode).toBe(200);
  });
});

/*
 * Fastify's default JSON parser rejects an empty body under a JSON
 * content-type with FST_ERR_CTP_EMPTY_JSON_BODY (400), before the route
 * handler ever runs. `client/src/api.ts` works around it by omitting the
 * header when there is no body, but the daemon is the only party that can fix
 * it for curl, a script, or a second client - all of which reasonably set the
 * header on a POST that happens to carry nothing.
 */
describe("bodyless POSTs that still declare a JSON content-type", () => {
  const cases = [
    { url: "/api/server/stop", expected: 409 }, // not running
    { url: "/api/server/kill", expected: 409 }, // nothing to kill
    { url: "/api/server/update", expected: 200 },
    { url: "/api/mods/update-all", expected: 200 },
  ];

  for (const { url, expected } of cases) {
    it(`treats an empty body as absent on POST ${url}`, async () => {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload: "",
      });
      expect(res.json().code, url).toBeUndefined(); // no FST_ERR_CTP_EMPTY_JSON_BODY
      expect(res.statusCode, url).toBe(expected);
    });
  }

  it("treats an empty body as absent when the header carries a charset too", async () => {
    // What PowerShell's Invoke-RestMethod and most HTTP libraries actually
    // send, rather than the bare type curl uses.
    const res = await app.inject({
      method: "POST",
      url: "/api/server/stop",
      headers: { "content-type": "application/json; charset=utf-8" },
      payload: "",
    });
    expect(res.json().code).toBeUndefined();
    expect(res.statusCode).toBe(409);
  });

  it("still parses a real JSON body under the same header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/server/start",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ world: "Tulsa" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status.world).toBe("Tulsa");
  });

  it("still rejects a malformed JSON body rather than silently ignoring it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/server/start",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
  });
});

// A task whose promise never settles at all - a hung steamcmd network read, a
// Steam-side prompt nobody can answer - would otherwise hold its id forever.
// Now that the set lives in the daemon, reloading the client no longer clears
// it; only restarting the daemon would. So the entry expires. The child is
// deliberately left running: killing steamcmd mid-write can leave a
// half-written install or truncated jar, which is worse than a stale flag.
describe("task expiry", () => {
  /** Joins the live socket set so a test can read what the daemon pushed. */
  function captureBroadcasts(instance: ReturnType<typeof buildServer>): WsMessage[] {
    const seen: WsMessage[] = [];
    (instance as unknown as { sockets: Set<{ send(d: string): void }> }).sockets.add({
      send: (d: string) => void seen.push(JSON.parse(d) as WsMessage),
    });
    return seen;
  }

  it("drops an expired task from activeTasks, unblocks start, and says why", async () => {
    // Only setTimeout/clearTimeout are faked: faking setImmediate as well
    // would stall Fastify's inject.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const seen = captureBroadcasts(app);
      const { taskId } = (await app.inject({ method: "POST", url: "/api/server/update" })).json();
      expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([
        taskId,
      ]);
      // steamcmd never exits - the child is still there, just silent.
      expect(spawn.calls[0].child.killed).toBe(false);

      vi.advanceTimersByTime(TASK_EXPIRY_MS);

      expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([]);
      // The client learns why, rather than the line just vanishing.
      const done = seen.filter((m) => m.type === "task-done");
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ taskId, ok: false });
      expect((done[0] as { error: string }).error).toMatch(/timed out/i);
      // Never killed: a half-written install is worse than a stale flag.
      expect(spawn.calls[0].child.killed).toBe(false);

      const started = await app.inject({
        method: "POST",
        url: "/api/server/start",
        payload: { world: "Tulsa" },
      });
      expect(started.statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is harmless when an expired task completes anyway", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let seen: WsMessage[];
    let taskId: string;
    try {
      seen = captureBroadcasts(app);
      taskId = (await app.inject({ method: "POST", url: "/api/server/update" })).json().taskId;
      vi.advanceTimersByTime(TASK_EXPIRY_MS);
      // The daemon has given up: the one terminal message so far is the
      // timeout, sent while steamcmd is still running.
      const afterExpiry = seen.filter((m) => m.type === "task-done");
      expect(afterExpiry).toHaveLength(1);
      expect((afterExpiry[0] as { ok: boolean; error: string }).error).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }

    // The long-running steamcmd finally exits, well after the daemon gave up.
    expect(() => spawn.calls[0].child.exit(0)).not.toThrow();
    await vi.waitFor(async () => {
      const res = await app.inject({ method: "GET", url: "/api/status" });
      expect(res.json().activeTasks).toEqual([]);
    });
    // Still exactly one terminal message for the id - the late result is
    // discarded, not broadcast as a second task-done, and never re-added.
    expect(seen!.filter((m) => m.type === "task-done" && m.taskId === taskId!)).toHaveLength(1);
  });

  it("leaves a task well inside the bound completely alone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const seen = captureBroadcasts(app);
      const { taskId } = (await app.inject({ method: "POST", url: "/api/server/update" })).json();

      vi.advanceTimersByTime(TASK_EXPIRY_MS - 1);

      expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([
        taskId,
      ]);
      expect(seen.filter((m) => m.type === "task-done")).toHaveLength(0);

      // It then finishes normally, and the pending expiry must not fire later.
      spawn.calls[0].child.exit(0);
      // Deliberately NOT vi.waitFor: under fake timers it advances the clock
      // itself, which would trip the expiry and defeat the test. setImmediate
      // is unfaked here, so one macrotask drains the promise chain instead.
      await new Promise((r) => setImmediate(r));
      expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([]);

      vi.advanceTimersByTime(TASK_EXPIRY_MS * 2);

      const done = seen.filter((m) => m.type === "task-done");
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ taskId, ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("POST /api/server/start task interlock", () => {
  it("returns 409 while a task is active, and works again once it finishes", async () => {
    await app.inject({ method: "POST", url: "/api/server/update" });

    const blocked = await app.inject({
      method: "POST",
      url: "/api/server/start",
      payload: { world: "Tulsa" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatch(/task/i);
    expect(spawn.calls).toHaveLength(1); // steamcmd only; no server was spawned

    spawn.calls[0].child.exit(0);
    await vi.waitFor(async () => {
      const res = await app.inject({ method: "GET", url: "/api/status" });
      expect(res.json().activeTasks).toEqual([]);
    });

    const allowed = await app.inject({
      method: "POST",
      url: "/api/server/start",
      payload: { world: "Tulsa" },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("still rejects an invalid world name with 400 rather than the interlock's 409", async () => {
    await app.inject({ method: "POST", url: "/api/server/update" });
    const res = await app.inject({
      method: "POST",
      url: "/api/server/start",
      payload: { world: "bad:name" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/worlds", () => {
  it("lists worlds and echoes lastWorld", async () => {
    const res = await app.inject({ method: "GET", url: "/api/worlds" });
    expect(res.json().worlds.map((w: { name: string }) => w.name)).toEqual(["Tulsa"]);
    expect(res.json().lastWorld).toBeNull();
  });

  it("reports whether a candidate name would be created or loaded", async () => {
    const a = await app.inject({ method: "GET", url: "/api/worlds?name=Tulsa" });
    expect(a.json().candidate).toEqual({ name: "Tulsa", exists: true, valid: true });
    const b = await app.inject({ method: "GET", url: "/api/worlds?name=Brand%20New" });
    expect(b.json().candidate).toEqual({ name: "Brand New", exists: false, valid: true });
    const c = await app.inject({ method: "GET", url: "/api/worlds?name=bad%3Aname" });
    expect(c.json().candidate.valid).toBe(false);
  });
});

describe("POST /api/server/start", () => {
  it("starts and persists lastWorld only once running", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/server/start",
      payload: { world: "Tulsa" },
    });
    expect(res.statusCode).toBe(200);
    expect(pm.status.state).toBe("starting");
    expect((await app.inject({ method: "GET", url: "/api/worlds" })).json().lastWorld).toBeNull();
    spawn.calls[0].child.emitLine(F.READY_LINE_WITH_TS);
    await vi.waitFor(async () => {
      const w = (await app.inject({ method: "GET", url: "/api/worlds" })).json();
      expect(w.lastWorld).toBe("Infected Toenail");
    });
  });

  it("rejects an invalid world name with 400 before spawning", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/server/start",
      payload: { world: "bad:name" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/world name/i);
    expect(spawn.calls).toHaveLength(0);
  });

  it("returns 409 with the real message when already running", async () => {
    await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
    const res = await app.inject({
      method: "POST",
      url: "/api/server/start",
      payload: { world: "Tulsa" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already starting/i);
  });
});

describe("POST /api/server/stop", () => {
  it("returns 409 when not running", async () => {
    const res = await app.inject({ method: "POST", url: "/api/server/stop" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not running/i);
  });

  it("surfaces the timeout message as 504 without killing", async () => {
    await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
    spawn.calls[0].child.emitLine(F.READY_LINE_WITH_TS);
    const res = await app.inject({ method: "POST", url: "/api/server/stop" });
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toMatch(/did not exit/i);
    expect(spawn.calls[0].child.killed).toBe(false);
  });
});

describe("mod mutation guard", () => {
  it("refuses to add, remove, update mods, or update the server while running", async () => {
    await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
    spawn.calls[0].child.emitLine(F.READY_LINE_WITH_TS);
    for (const [method, url, payload] of [
      ["POST", "/api/mods", { id: "1", name: "A" }],
      ["DELETE", "/api/mods/1", undefined],
      ["POST", "/api/mods/update-all", undefined],
      ["POST", "/api/server/update", undefined],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json().error).toMatch(/running/i);
    }
  });

  it("also refuses mutations while the server is still starting", async () => {
    await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
    // No READY line emitted: pm.status.state is still "starting" here, which
    // is the realistic case (e.g. clicking Update All during mod loading).
    expect(pm.status.state).toBe("starting");
    for (const [method, url, payload] of [
      ["POST", "/api/mods", { id: "1", name: "A" }],
      ["DELETE", "/api/mods/1", undefined],
      ["POST", "/api/mods/update-all", undefined],
      ["POST", "/api/server/update", undefined],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json().error).toMatch(/starting/i);
    }
  });
});

describe("POST /api/mods validation", () => {
  it("rejects a non-numeric workshop id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mods",
      payload: { id: "not-an-id", name: "X" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/workshop id/i);
  });

  it("rejects a blank name that Steam cannot fill in either", async () => {
    // The fake fetch's default answer is "Steam knows nothing about this id",
    // so there is no title to fall back to and no placeholder is invented.
    const res = await app.inject({
      method: "POST",
      url: "/api/mods",
      payload: { id: "123", name: "  " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/supply a name/i);
  });
});

// A workshop id is the only thing a user actually has; the name is Steam's to
// know. Resolving it is best-effort and must never invent one, because whatever
// lands here is written into mods.json and shown in the UI from then on.
describe("POST /api/mods name resolution", () => {
  it("resolves the title from Steam when no name is supplied", async () => {
    const install = vi.spyOn(installer, "install").mockResolvedValue({
      id: "3731244177",
      name: "Safe Haven QOL",
      jar: "SafeHavenQOL.jar",
      ok: true,
    });
    net.respondJson(detailsBody([{ id: "3731244177", title: "Safe Haven QOL" }]));

    const res = await app.inject({ method: "POST", url: "/api/mods", payload: { id: "3731244177" } });

    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    expect(install.mock.calls[0][1]).toBe("Safe Haven QOL");
  });

  it("prefers an explicitly supplied name and never asks Steam", async () => {
    const install = vi.spyOn(installer, "install").mockResolvedValue({
      id: "3731244177",
      name: "My Own Name",
      jar: "x.jar",
      ok: true,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/mods",
      payload: { id: "3731244177", name: "My Own Name" },
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    expect(install.mock.calls[0][1]).toBe("My Own Name");
    expect(net.calls).toHaveLength(0);
  });

  it("fails with a 400 telling the user to supply a name when Steam is unreachable", async () => {
    net.failWith("getaddrinfo ENOTFOUND api.steampowered.com");
    const res = await app.inject({ method: "POST", url: "/api/mods", payload: { id: "3731244177" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/supply a name/i);
    // The underlying reason survives rather than being swallowed.
    expect(res.json().error).toContain("ENOTFOUND");
    expect(spawn.calls).toHaveLength(0);
  });

  it("still refuses a nameless add while the server is running", async () => {
    const install = vi.spyOn(installer, "install");
    net.respondJson(detailsBody([{ id: "3731244177", title: "Resolved" }]));
    await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
    spawn.calls[0].child.emitLine(F.READY_LINE_WITH_TS);
    const res = await app.inject({ method: "POST", url: "/api/mods", payload: { id: "3731244177" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/running/i);
    expect(install).not.toHaveBeenCalled();
  });

  it("still refuses a nameless add while a background task is running", async () => {
    // The half of the guard pair that name resolution actually put at risk:
    // an add that resolves a title must not slip past an in-flight steamcmd.
    const install = vi.spyOn(installer, "install");
    net.respondJson(detailsBody([{ id: "3731244177", title: "Resolved" }]));
    await app.inject({ method: "POST", url: "/api/server/update" });
    const res = await app.inject({ method: "POST", url: "/api/mods", payload: { id: "3731244177" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/background task/i);
    expect(install).not.toHaveBeenCalled();
  });

  /*
   * The interlock is only worth anything if it is atomic. Name resolution
   * introduced an await between "is anything in flight?" and reserving the
   * slot, so two nameless adds could both pass the check while both sat in the
   * Steam round trip - and both then ran steamcmd against modsDir at once,
   * which is precisely the corruption the interlock exists to prevent. The
   * window was as long as the Steam call, up to the full request timeout.
   */
  it("refuses a second nameless add fired while the first is still resolving its name", async () => {
    const install = vi
      .spyOn(installer, "install")
      // Never settles: the accepted task stays in activeTasks, which is the
      // state the second request has to be refused against.
      .mockImplementation(() => new Promise(() => {}));
    const release = net.hangThenJson(
      detailsBody([
        { id: "111", title: "First" },
        { id: "222", title: "Second" },
      ]),
    );

    // `.then()` is what actually dispatches an inject()ed request - holding the
    // chainable object alone runs nothing, which is enough to make a naive
    // version of this test pass against the very bug it is meant to catch.
    const first = app.inject({ method: "POST", url: "/api/mods", payload: { id: "111" } }).then((r) => r);
    const second = app.inject({ method: "POST", url: "/api/mods", payload: { id: "222" } }).then((r) => r);
    // Both requests are genuinely inside the Steam round trip at the same time
    // before either is allowed to continue. Without this the two serialize and
    // the race is never exercised.
    await vi.waitFor(() => expect(net.calls).toHaveLength(2));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect(refused.json().error).toMatch(/background task/i);

    // Drain the microtask queue the accepted task's work is scheduled on.
    await new Promise((r) => setImmediate(r));
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("still rejects a non-numeric id before touching Steam", async () => {
    const res = await app.inject({ method: "POST", url: "/api/mods", payload: { id: "../../etc" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/workshop id/i);
    expect(net.calls).toHaveLength(0);
  });
});

/*
 * Kept out of GET /api/mods on purpose: that list comes off disk and has to
 * survive Steam being down, so the badge data is a second call and an outage
 * costs badges rather than the mod list.
 */
describe("GET /api/mods/updates", () => {
  const installed = async (id: string, name: string, lastUpdated: string): Promise<void> =>
    registry.upsert({ id, name, jar: `${name}.jar`, lastUpdated });

  it("flags a mod whose workshop entry changed after it was installed", async () => {
    await installed("111", "Old Local Name", "2026-01-01T00:00:00.000Z");
    await installed("222", "Current", "2026-06-01T00:00:00.000Z");
    net.respondJson(
      detailsBody([
        { id: "111", title: "Fancy New Title", timeUpdated: Math.floor(Date.parse("2026-05-01T00:00:00.000Z") / 1000) },
        { id: "222", title: "Current", timeUpdated: Math.floor(Date.parse("2026-02-01T00:00:00.000Z") / 1000) },
      ]),
    );

    const res = await app.inject({ method: "GET", url: "/api/mods/updates" });

    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries(
      (res.json().mods as Array<{ id: string }>).map((m) => [m.id, m]),
    );
    expect(byId["111"]).toMatchObject({
      updateAvailable: true,
      onWorkshop: true,
      title: "Fancy New Title",
      workshopUpdatedAt: "2026-05-01T00:00:00.000Z",
      installedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(byId["222"]).toMatchObject({ updateAvailable: false, onWorkshop: true });
  });

  it("falls back to the registry's name and claims no update for an id Steam does not know", async () => {
    await installed("999", "Locally Known", "2026-01-01T00:00:00.000Z");
    net.respondJson(detailsBody([{ id: "999", result: 9 }]));
    const [mod] = (await app.inject({ method: "GET", url: "/api/mods/updates" })).json().mods;
    expect(mod).toMatchObject({
      title: "Locally Known",
      onWorkshop: false,
      workshopUpdatedAt: null,
      updateAvailable: false,
    });
  });

  it("treats a banned entry as no usable workshop entry, not as an installable update", async () => {
    await installed("111", "Locally Known", "2026-01-01T00:00:00.000Z");
    net.respondJson(
      detailsBody([
        {
          id: "111",
          title: "Naughty Mod",
          banned: true,
          timeUpdated: Math.floor(Date.parse("2026-05-01T00:00:00.000Z") / 1000),
        },
      ]),
    );
    const [mod] = (await app.inject({ method: "GET", url: "/api/mods/updates" })).json().mods;
    expect(mod).toMatchObject({
      title: "Locally Known",
      onWorkshop: false,
      workshopUpdatedAt: null,
      updateAvailable: false,
    });
  });

  it("says Steam failed rather than reporting a fabricated 'no updates'", async () => {
    await installed("111", "A", "2026-01-01T00:00:00.000Z");
    net.failWith("connect ETIMEDOUT 23.4.5.6:443");
    const res = await app.inject({ method: "GET", url: "/api/mods/updates" });
    expect(res.statusCode).toBe(502);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toContain("ETIMEDOUT");
    expect(res.json().mods).toBeUndefined();
  });

  it("leaves GET /api/mods working while Steam is down", async () => {
    await installed("111", "A", "2026-01-01T00:00:00.000Z");
    net.failWith("getaddrinfo ENOTFOUND api.steampowered.com");
    const res = await app.inject({ method: "GET", url: "/api/mods" });
    expect(res.statusCode).toBe(200);
    expect(res.json().managed).toHaveLength(1);
  });

  it("answers without a network call when nothing is managed", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mods/updates" });
    expect(res.statusCode).toBe(200);
    expect(res.json().mods).toEqual([]);
    expect(net.calls).toHaveLength(0);
  });

  it("carries the thumbnail and a blurb through, for no extra Steam traffic", async () => {
    // The WorkshopItem fetched to compare timestamps already holds both, so
    // dropping them and refetching later would be pure waste.
    await installed("111", "A", "2026-01-01T00:00:00.000Z");
    net.respondJson(
      detailsBody([
        {
          id: "111",
          previewUrl: "https://images.example/thumb.jpg",
          description: "[h1]Title[/h1] Adds a thing.",
        },
      ]),
    );
    const [mod] = (await app.inject({ method: "GET", url: "/api/mods/updates" })).json().mods;
    expect(mod.previewUrl).toBe("https://images.example/thumb.jpg");
    expect(mod.description).toBe("Title Adds a thing.");
    expect(net.calls).toHaveLength(1);
  });

  it("reports an empty thumbnail and blurb for an id Steam does not know", async () => {
    // Same condition as onWorkshop: false. An empty string, never undefined,
    // so the client renders nothing rather than "undefined".
    await installed("999", "Locally Known", "2026-01-01T00:00:00.000Z");
    net.respondJson(detailsBody([{ id: "999", result: 9 }]));
    const [mod] = (await app.inject({ method: "GET", url: "/api/mods/updates" })).json().mods;
    expect(mod).toMatchObject({ onWorkshop: false, previewUrl: "", description: "" });
  });
});

describe("GET /api/workshop/search", () => {
  it("says plainly that no key is configured instead of relaying Steam's 403", async () => {
    const res = await app.inject({ method: "GET", url: "/api/workshop/search?q=torch" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/api key/i);
    expect(res.json().error).not.toMatch(/403|forbidden/i);
    expect(net.calls).toHaveLength(0);
  });

  it("passes the query and cursor through and returns what a UI needs", async () => {
    cfg.steamApiKey = FAKE_KEY;
    net.respondJson({
      response: {
        total: 2,
        next_cursor: "PAGE2",
        publishedfiledetails: [
          {
            publishedfileid: "3731244177",
            title: "Safe Haven QOL",
            preview_url: "https://images.example/a.jpg",
            time_updated: 1_700_000_000,
            subscriptions: 4242,
          },
        ],
      },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/workshop/search?q=torch&cursor=%2A&count=5",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().nextCursor).toBe("PAGE2");
    expect(res.json().total).toBe(2);
    expect(res.json().items[0]).toEqual({
      id: "3731244177",
      title: "Safe Haven QOL",
      previewUrl: "https://images.example/a.jpg",
      description: "",
      subscriptions: 4242,
      fileSize: 0,
      updatedAt: new Date(1_700_000_000 * 1000).toISOString(),
    });
    const sent = new URL(net.calls[0].url);
    expect(sent.searchParams.get("search_text")).toBe("torch");
    expect(sent.searchParams.get("cursor")).toBe("*");
  });

  it("blames the caller, not Steam, for a repeated query parameter", async () => {
    cfg.steamApiKey = FAKE_KEY;
    const res = await app.inject({ method: "GET", url: "/api/workshop/search?q=a&q=b" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/"q"/);
    expect(net.calls).toHaveLength(0);
  });

  it("reports an upstream failure as 502 without leaking the key", async () => {
    cfg.steamApiKey = FAKE_KEY;
    net.respondRaw(403, "Forbidden", "<html>Access is denied</html>");
    const res = await app.inject({ method: "GET", url: "/api/workshop/search?q=torch" });
    expect(res.statusCode).toBe(502);
    expect(res.payload).not.toContain(FAKE_KEY);
  });
});

describe("GET /api/mods", () => {
  it("returns managed and untracked lists", async () => {
    await writeFile(join(cfg.modsDir, "Mystery.jar"), "x");
    const res = await app.inject({ method: "GET", url: "/api/mods" });
    expect(res.json()).toEqual({ managed: [], untracked: [{ jar: "Mystery.jar" }] });
  });
});

describe("DELETE /api/mods/:id", () => {
  it("returns 404 for an id that is not managed by this daemon", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/mods/999" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not managed/i);
  });
});

describe("POST /api/server/kill", () => {
  it("kills a managed process", async () => {
    await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
    const res = await app.inject({ method: "POST", url: "/api/server/kill" });
    expect(res.statusCode).toBe(200);
    expect(spawn.calls[0].child.killed).toBe(true);
  });

  it("returns 409 with the real message when there is nothing to kill", async () => {
    const res = await app.inject({ method: "POST", url: "/api/server/kill" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/no managed server/i);
  });
});

describe("GET /api/config", () => {
  it("returns the current config", async () => {
    const res = await app.inject({ method: "GET", url: "/api/config" });
    expect(res.json().stopTimeoutMs).toBe(50);
  });

  // This API has no authentication by design, so anything it returns is
  // readable by every device on the LAN. The Steam key must not be one of them.
  it("never returns the Steam API key, only whether one is set", async () => {
    cfg.steamApiKey = FAKE_KEY;
    const res = await app.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(FAKE_KEY);
    expect(res.json().steamApiKey).toBeUndefined();
    expect(res.json().steamApiKeyConfigured).toBe(true);
  });

  it("reports no key configured when the field is empty or blank", async () => {
    expect((await app.inject({ method: "GET", url: "/api/config" })).json().steamApiKeyConfigured).toBe(
      false,
    );
    cfg.steamApiKey = "   ";
    expect((await app.inject({ method: "GET", url: "/api/config" })).json().steamApiKeyConfigured).toBe(
      false,
    );
  });
});

describe("PUT /api/config", () => {
  it("accepts an allowed field", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { stopTimeoutMs: 5000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stopTimeoutMs).toBe(5000);
  });

  it("rejects a disallowed field with 400 naming the field", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { javaExe: "C:\\evil.exe" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/javaExe/);
  });

  // The key is hand-edited on the box like every other sensitive field: with no
  // authentication, a settable key is a key anyone on the LAN can overwrite.
  it("refuses to set the Steam API key remotely and leaves the stored one alone", async () => {
    cfg.steamApiKey = FAKE_KEY;
    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { steamApiKey: "attacker-supplied" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/steamApiKey/);
    expect(cfg.steamApiKey).toBe(FAKE_KEY);
  });

  it("does not echo the key back on a successful patch either", async () => {
    cfg.steamApiKey = FAKE_KEY;
    const res = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: { stopTimeoutMs: 5000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(FAKE_KEY);
    expect(res.json().steamApiKeyConfigured).toBe(true);
  });
});

/*
 * World settings. This is the one part of the API that writes inside somebody's
 * only copy of a save, so its guards are deliberately stricter than everything
 * above: the server must be confirmed `stopped` rather than merely asked to
 * stop, no background task may be in flight, and every value is checked before
 * the zip is opened at all.
 */
describe("world settings", () => {
  const WORLD = "Tulsa What";
  let zipPath: string;

  const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
  const zipBytes = (): Promise<Buffer> => readFile(zipPath);

  beforeEach(async () => {
    zipPath = await makeWorldZip(cfg.worldsDir, WORLD);
  });

  const settings = (world = WORLD): Promise<Injected> =>
    app.inject({ method: "GET", url: `/api/worlds/${encodeURIComponent(world)}/settings` });

  const put = (payload: object, world = WORLD): Promise<Injected> =>
    app.inject({ method: "PUT", url: `/api/worlds/${encodeURIComponent(world)}/settings`, payload });

  const fieldsOf = async (world = WORLD): Promise<Record<string, unknown>[]> =>
    (await settings(world)).json().fields;

  const valueOf = async (key: string): Promise<unknown> =>
    (await fieldsOf()).find((f) => f.key === key)?.value;

  describe("GET", () => {
    it("reports every key in the file, in the file's order", async () => {
      const res = await settings();
      expect(res.statusCode).toBe(200);
      expect(res.json().entry).toBe(`${WORLD}/worldSettings.cfg`);
      expect(res.json().fields.map((f: { key: string }) => f.key)).toEqual([
        "allowCheats",
        "difficulty",
        "deathPenalty",
        "raidFrequency",
        "survivalMode",
        "playerHunger",
        "disableMobSpawns",
        "forcedPvP",
        "allowOutsideCharacters",
        "creativeMode",
        "disableMobAI",
        "canSettlersDie",
        "dayTimeMod",
        "nightTimeMod",
        "gameVersion",
        "rpgskillsWorldStackLevel",
        "rpgskillsChestSlotUpgradeLevel",
        "rpgskillsWelcomeMessageShown",
      ]);
    });

    // The point of shipping the option sets: a client that hardcoded them would
    // be guessing at what the game accepts, and a wrong guess corrupts a world
    // to find out.
    it("ships each enum's real option set so a form never has to guess", async () => {
      const fields = await fieldsOf();
      const by = (k: string): Record<string, unknown> | undefined => fields.find((f) => f.key === k);
      expect(by("difficulty")).toMatchObject({
        type: "enum",
        options: ["CASUAL", "ADVENTURE", "CLASSIC", "HARD", "BRUTAL"],
        editable: true,
      });
      expect(by("deathPenalty")?.options).toEqual([
        "NONE",
        "DROP_MATS",
        "DROP_MAIN_INVENTORY",
        "DROP_FULL_INVENTORY",
        "HARDCORE",
      ]);
      expect(by("raidFrequency")?.options).toEqual(["OFTEN", "OCCASIONALLY", "RARELY", "NEVER"]);
      expect(by("allowCheats")).toMatchObject({ type: "boolean", value: "false", editable: true });
      expect(by("dayTimeMod")).toMatchObject({ type: "float", value: "1.0", max: 10, editable: true });
    });

    it("flags gameVersion as the game's to write, not the form's", async () => {
      const fields = await fieldsOf();
      expect(fields.find((f) => f.key === "gameVersion")).toMatchObject({
        type: "string",
        value: "1.2.0",
        editable: false,
      });
    });

    it("reports mod-written keys as unknown and uneditable rather than hiding them", async () => {
      const fields = await fieldsOf();
      for (const key of [
        "rpgskillsWorldStackLevel",
        "rpgskillsChestSlotUpgradeLevel",
        "rpgskillsWelcomeMessageShown",
      ]) {
        expect(fields.find((f) => f.key === key), key).toMatchObject({ type: null, editable: false });
      }
    });

    it("404s a world that is not there", async () => {
      const res = await settings("No Such World");
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/No world named/);
    });

    it("reports a world file that is not a readable zip as a failure, not as empty settings", async () => {
      // `Tulsa.zip` is the one-byte placeholder this suite's beforeEach writes.
      const res = await settings("Tulsa");
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toMatch(/not a readable zip/);
    });
  });

  describe("name handling", () => {
    // The name reaches the filesystem. It is validated, and then resolved
    // against the real listing rather than joined onto worldsDir, so neither
    // half alone is what stops a traversal.
    it("refuses a name that could escape the worlds directory", async () => {
      for (const name of ["..", ".", "../../Server", "..\\..\\Server", "a/b", "a|b"]) {
        // Dots are percent-encoded too, so the request reaches the route with
        // the name the caller meant rather than one the router has already
        // collapsed: what is under test is this daemon's refusal, not
        // find-my-way's path normalisation.
        const encoded = encodeURIComponent(name).replace(/\./g, "%2E");
        for (const method of ["GET", "PUT"] as const) {
          const res = await app.inject({
            method,
            url: `/api/worlds/${encoded}/settings`,
            ...(method === "PUT" ? { payload: { allowCheats: true } } : {}),
          });
          // Either this daemon refused the name (400) or the router never
          // matched a route for it at all (404). Both are refusals. What must
          // never appear is a 200, or a 500 from something having gone off and
          // tried to open a file.
          expect([400, 404], `${method} ${name} -> ${res.statusCode}`).toContain(res.statusCode);
        }
      }
    });

    it("says so plainly when the traversal attempt does reach the route", async () => {
      // These survive routing as a single path segment, so the refusal is this
      // daemon's own rather than find-my-way declining to match.
      for (const name of ["a/b", "a|b", "..\\..\\Server"]) {
        const res = await app.inject({
          method: "GET",
          url: `/api/worlds/${encodeURIComponent(name)}/settings`,
        });
        expect(res.statusCode, name).toBe(400);
        expect(res.json().error, name).toMatch(/Invalid world name/);
      }
    });

    it("404s rather than writing when the name is valid but no such world exists", async () => {
      const res = await put({ allowCheats: true }, "Somewhere Else");
      expect(res.statusCode).toBe(404);
    });
  });

  describe("PUT guards", () => {
    it("refuses unless the server is a confirmed stopped", async () => {
      const before = await zipBytes();
      await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
      expect(pm.status.state).not.toBe("stopped");

      const res = await put({ allowCheats: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/confirmed stopped/);
      expect(sha(await zipBytes())).toBe(sha(before));
    });

    // Stricter than the mod routes on purpose: `crashed` is precisely the case
    // where nobody can say what the server was doing to the zip when it died.
    it("refuses after a crash, which the looser guards elsewhere allow", async () => {
      await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
      spawn.calls[0].child.exit(1);
      await vi.waitFor(() => {
        expect(pm.status.state).toBe("crashed");
      });

      const res = await put({ allowCheats: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/crashed/);
    });

    it("refuses while a server this daemon did not start is running", async () => {
      pm.markUnmanaged(4321);
      const res = await put({ allowCheats: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/unmanaged/);
    });

    it("refuses while a background task is in flight", async () => {
      const before = await zipBytes();
      await app.inject({ method: "POST", url: "/api/server/update" });

      const res = await put({ allowCheats: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/background task/i);
      expect(sha(await zipBytes())).toBe(sha(before));

      spawn.calls[0].child.exit(0);
      await vi.waitFor(async () => {
        expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([]);
      });
      expect((await put({ allowCheats: true })).statusCode).toBe(200);
    });

    it("never stops the server to win itself permission to write", async () => {
      await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
      const stateBefore = pm.status.state;
      await put({ allowCheats: true });
      expect(pm.status.state).toBe(stateBefore);
    });
  });

  describe("PUT validation, all of it before the zip is opened", () => {
    const rejected: [string, unknown, RegExp][] = [
      ["gameVersion", "9.9.9", /written by the game/],
      ["allowCheats", "yes", /must be true or false/],
      ["allowCheats", 1, /must be true or false/],
      ["difficulty", "IMPOSSIBLE", /must be one of CASUAL, ADVENTURE, CLASSIC, HARD, BRUTAL/],
      ["difficulty", 3, /must be one of/],
      ["dayTimeMod", 11, /at most 10/],
      ["dayTimeMod", 0, /at least 0\.1/],
      ["dayTimeMod", "1.5", /must be a number/],
      ["rpgskillsWorldStackLevel", 2, /not a world setting this daemon knows/],
      ["notAFieldAtAll", true, /not a world setting this daemon knows/],
    ];

    for (const [key, value, message] of rejected) {
      it(`rejects ${key} = ${JSON.stringify(value)} and writes nothing`, async () => {
        const before = await zipBytes();
        const res = await put({ [key]: value });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(message);
        expect(sha(await zipBytes())).toBe(sha(before));
        expect(await readdir(cfg.worldsDir)).not.toContain("settings-backups");
      });
    }

    it("rejects the whole request when one change of several is bad", async () => {
      const before = await zipBytes();
      const res = await put({ allowCheats: true, difficulty: "NIGHTMARE", survivalMode: false });
      expect(res.statusCode).toBe(400);
      expect(sha(await zipBytes())).toBe(sha(before));
    });

    // A world whose file never had `maxSettlersPerSettlement` must not gain
    // one: adding a field the game left out changes how the world behaves.
    it("refuses a known field this world's file does not already contain", async () => {
      const before = await zipBytes();
      const res = await put({ maxSettlersPerSettlement: 12 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/no "maxSettlersPerSettlement" line/);
      expect(sha(await zipBytes())).toBe(sha(before));
    });

    it("rejects a body that is not an object of settings", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/worlds/${encodeURIComponent(WORLD)}/settings`,
        payload: ["allowCheats"],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/must be an object/);
    });
  });

  describe("PUT applies changes", () => {
    it("writes the requested values, backs the world up, and reports what changed", async () => {
      const original = await zipBytes();
      const res = await put({ allowCheats: true, difficulty: "HARD", dayTimeMod: 2.5 });

      expect(res.statusCode).toBe(200);
      expect([...res.json().changed].sort()).toEqual(["allowCheats", "dayTimeMod", "difficulty"]);
      expect(sha(await readFile(res.json().backup))).toBe(sha(original));

      expect(await valueOf("allowCheats")).toBe("true");
      expect(await valueOf("difficulty")).toBe("HARD");
      expect(await valueOf("dayTimeMod")).toBe("2.5");
      // Untouched fields, mod keys included, are exactly as they were.
      expect(await valueOf("gameVersion")).toBe("1.2.0");
      expect(await valueOf("rpgskillsWorldStackLevel")).toBe("1");
    });

    it("changes only the lines it was asked to, comments and all", async () => {
      expect((await put({ forcedPvP: true })).statusCode).toBe(200);
      const open = await openWorldSettings(zipPath);
      expect(open.file.text()).toBe(WORLD_SETTINGS_CFG.replace("forcedPvP = false", "forcedPvP = true"));
    });

    it("writes a whole float back the way the game spells it", async () => {
      await put({ nightTimeMod: 3 });
      expect(await valueOf("nightTimeMod")).toBe("3.0");
    });

    // Saving a form nobody edited must not rewrite a 12MB world zip, and must
    // not fill the backups folder with copies of an unchanged file.
    it("writes nothing at all when every requested value already matches", async () => {
      const before = await zipBytes();
      const res = await put({ allowCheats: false, difficulty: "CLASSIC", dayTimeMod: 1 });

      expect(res.statusCode).toBe(200);
      expect(res.json().changed).toEqual([]);
      expect(res.json().backup).toBeNull();
      expect(sha(await zipBytes())).toBe(sha(before));
      expect(await readdir(cfg.worldsDir)).not.toContain("settings-backups");
    });
  });
});
