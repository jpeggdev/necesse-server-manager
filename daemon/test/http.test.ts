import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, TASK_EXPIRY_MS } from "../src/http.js";
import { ProcessManager } from "../src/process-manager.js";
import { ModInstaller } from "../src/mod-installer.js";
import { ModRegistry } from "../src/mod-registry.js";
import { ModLibrary } from "../src/mod-library.js";
import { ModSets } from "../src/mod-sets.js";
import { LaunchOptions } from "../src/launch-options.js";
import { PlayerRoster } from "../src/player-roster.js";
import { SteamCmd } from "../src/steamcmd.js";
import { SteamWorkshop } from "../src/steam-workshop.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { makeFakeSpawn } from "./fixtures/fake-spawn.js";
import { makeFakeFetch, detailsBody, type FakeFetch } from "./fixtures/fake-fetch.js";
import type { DaemonConfig, WsMessage } from "../src/types.js";
import * as F from "./fixtures/log-fixtures.js";
import { makeWorldZip, WORLD_SETTINGS_CFG } from "./fixtures/world-zip.js";
import {
  MOD_INFO_SUMMONER_EXPANSION,
  makeModJar,
  makeNonModJar,
  modJarBytes,
} from "./fixtures/mod-jar.js";
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
let library: ModLibrary;
let sets: ModSets;
let steam: SteamCmd;
let net: FakeFetch;
let workshop: SteamWorkshop;
let launchOptions: LaunchOptions;
let playerRoster: PlayerRoster;
let app: ReturnType<typeof buildServer>;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "necesse-http-"));
  const modsDir = join(root, "mods");
  const worldsDir = join(root, "worlds");
  await mkdir(modsDir, { recursive: true });
  await mkdir(worldsDir, { recursive: true });
  await writeFile(join(worldsDir, "Tulsa.zip"), "x");
  cfg = {
    ...DEFAULT_CONFIG,
    modsDir,
    worldsDir,
    stopTimeoutMs: 50,
    // Every path the library and the sets write to lives in this test's own
    // temp dir. DEFAULT_CONFIG leaves all three empty - they are derived from
    // the state directory by loadConfig, which is not involved here - so
    // without these a suite that started the server would resolve them
    // relative to the process's working directory and write a mod-sets.json
    // into the repo.
    modLibraryDir: join(root, "mod-library"),
    modLibraryFile: join(root, "mod-library.json"),
    modSetsFile: join(root, "mod-sets.json"),
    // Small enough that the oversize case is a few hundred bytes rather than
    // 64MB of test payload.
    modUploadMaxBytes: 4096,
  };
  configFile = join(root, "config.json");
  spawn = makeFakeSpawn();
  pm = new ProcessManager(cfg, spawn.spawn);
  steam = new SteamCmd(cfg, spawn.spawn);
  registry = new ModRegistry(join(root, "mods.json"));
  library = new ModLibrary(cfg.modLibraryFile, cfg.modLibraryDir);
  sets = new ModSets(cfg.modSetsFile);
  net = makeFakeFetch();
  workshop = new SteamWorkshop(cfg, net.fetch);
  installer = new ModInstaller(cfg, registry, steam, library, workshop);
  launchOptions = new LaunchOptions(join(root, "launch-options.json"));
  playerRoster = new PlayerRoster();
  app = buildServer({
    cfg,
    configFile,
    configWarnings: [],
    pm,
    installer,
    library,
    sets,
    steam,
    workshop,
    launchOptions,
    playerRoster,
  });
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
    const selfHealApp = buildServer({
      cfg,
      configFile,
      configWarnings: [],
      pm: deadPm,
      installer,
      library,
      sets,
      steam,
      workshop,
      launchOptions,
      playerRoster,
    });

    const res = await selfHealApp.inject({ method: "GET", url: "/api/status" });

    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe("stopped");
    expect(res.json().pid).toBeNull();
  });
});

// `Deps.configWarnings` reaching `statusPayload` is only real if some test
// fails when it doesn't - a literal `[]` in statusPayload would leave every
// other test in this suite green, since every other app in this file is built
// with configWarnings: []. These build an app with a real warning and check
// both channels a client can learn about it from: the poll and the socket
// backlog it gets on connect.
describe("configWarnings in the status payload", () => {
  const warning = "steamcmd is missing";

  it("carries a non-fatal configuration problem through GET /api/status", async () => {
    const warnedApp = buildServer({
      cfg,
      configFile,
      configWarnings: [warning],
      pm,
      installer,
      library,
      sets,
      steam,
      workshop,
      launchOptions,
      playerRoster,
    });

    const res = await warnedApp.inject({ method: "GET", url: "/api/status" });

    expect(res.json().configWarnings).toEqual([warning]);
  });

  it("carries the same warning in the websocket backlog frame a connecting client actually receives", async () => {
    const warnedApp = buildServer({
      cfg,
      configFile,
      configWarnings: [warning],
      pm,
      installer,
      library,
      sets,
      steam,
      workshop,
      launchOptions,
      playerRoster,
    });
    await warnedApp.ready();

    // The backlog frame is sent the instant the connection handler runs,
    // which can be before `injectWS`'s own promise resolves - a `message`
    // listener attached after `await` is a race that drops it. `onInit` runs
    // at socket creation, ahead of the handshake, so it cannot lose that race.
    let resolveBacklog!: (msg: WsMessage) => void;
    const backlogReceived = new Promise<WsMessage>((resolve) => {
      resolveBacklog = resolve;
    });
    const ws = await warnedApp.injectWS("/ws", undefined, {
      // `ws` ships no type declarations of its own (it's a transitive
      // dependency here, per the note at the top of ws-auth.test.ts), so
      // `socket` resolves to `any` and this callback gets none of its own -
      // annotated explicitly rather than left as an implicit any.
      onInit: (socket) => {
        socket.once("message", (data: unknown) =>
          resolveBacklog(JSON.parse(String(data)) as WsMessage),
        );
      },
    });
    try {
      const backlog = await backlogReceived;
      if (backlog.type !== "backlog") throw new Error(`Expected a backlog frame, got ${backlog.type}`);
      expect(backlog.status.configWarnings).toEqual([warning]);
    } finally {
      ws.terminate();
    }
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
      configWarnings: [],
      pm,
      installer,
      library,
      sets,
      steam: throwingSteam,
      workshop,
      launchOptions,
      playerRoster,
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

describe("players", () => {
  const TS = "[2026-08-01 21:31:04] ";
  const AUTH = "76561198048435182";

  /** Starts the server and drives it to running, which is where commands work. */
  async function running(): Promise<void> {
    await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
    spawn.calls[0].child.emitLine(F.READY_LINE_WITH_TS);
  }

  function connect(auth: string, name: string, slot: number): void {
    spawn.calls[0].child.emitLine(
      `${TS}Client "${auth}" with address 192.168.1.50:52134 is connecting with version 1.3.1.`,
    );
    spawn.calls[0].child.emitLine(`${TS}Client "${name}" connected on slot ${slot}/5.`);
  }

  it("reports an empty roster before anyone joins", async () => {
    const res = await app.inject({ method: "GET", url: "/api/players" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, players: [] });
  });

  it("reports a player the server said connected", async () => {
    await running();
    connect(AUTH, "Jeff", 1);
    const res = await app.inject({ method: "GET", url: "/api/players" });
    expect(res.json().players).toMatchObject([{ auth: AUTH, name: "Jeff", slot: 1 }]);
  });

  it("empties the roster when the server exits", async () => {
    await running();
    connect(AUTH, "Jeff", 1);
    spawn.calls[0].child.exit(0);
    await vi.waitFor(async () => {
      const res = await app.inject({ method: "GET", url: "/api/players" });
      expect(res.json().players).toEqual([]);
    });
  });

  it("asks the server who is online as soon as it is running", async () => {
    await running();
    expect(spawn.calls[0].child.written).toContain("players\n");
  });

  it("asks the server for /players on refresh", async () => {
    await running();
    spawn.calls[0].child.written.length = 0;
    const res = await app.inject({ method: "POST", url: "/api/players/refresh" });
    expect(res.json()).toEqual({ ok: true });
    expect(spawn.calls[0].child.written).toEqual(["players\n"]);
  });

  /*
   * The manual path gets the same retry as the automatic one. Pressed during
   * world startup, a single ask is accepted, echoed and silently ignored, and
   * the operator would be told it worked while the panel never changed.
   */
  it("keeps asking after a refresh the server never answers", () => {
    vi.useFakeTimers();
    try {
      runningNoHttp();
      spawn.calls[0].child.written.length = 0;
      void app.inject({ method: "POST", url: "/api/players/refresh" });
      vi.advanceTimersByTime(0);
      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(2000);
      expect(spawn.calls[0].child.written.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a refresh when the server is not running, saying why", async () => {
    const res = await app.inject({ method: "POST", url: "/api/players/refresh" });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not running/i);
  });

  /*
   * Measured on the real 1.3.1 server: a /players sent the instant the ready
   * line appears is echoed to the console and then does nothing, because the
   * world is still initialising. The same command moments later answers. The
   * daemon cannot tell those apart from the output, so it asks again until the
   * server replies.
   */
  /*
   * These drive the ProcessManager directly rather than through the start
   * route: the retry has to be created while the fake clock is installed, and
   * installing it around an `app.inject()` stalls Fastify's own awaits.
   */
  function runningNoHttp(): void {
    pm.start("Tulsa", {});
    spawn.calls[0].child.emitLine(F.READY_LINE_WITH_TS);
  }

  it("keeps asking when the server accepts the command but never answers", () => {
    vi.useFakeTimers();
    try {
      runningNoHttp();
      expect(spawn.calls[0].child.written).toEqual(["players\n"]);
      vi.advanceTimersByTime(2000);
      vi.advanceTimersByTime(2000);
      expect(spawn.calls[0].child.written.length).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops asking as soon as the server answers", () => {
    vi.useFakeTimers();
    try {
      runningNoHttp();
      spawn.calls[0].child.emitLine(`${TS}Players online: 0/5`);
      spawn.calls[0].child.written.length = 0;
      vi.advanceTimersByTime(30000);
      expect(spawn.calls[0].child.written).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up rather than asking a silent server forever", () => {
    vi.useFakeTimers();
    try {
      runningNoHttp();
      vi.advanceTimersByTime(120000);
      expect(spawn.calls[0].child.written.length).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces the roster from a /players block the server printed", async () => {
    await running();
    connect(AUTH, "Jeff", 1);
    connect("7656119800", "eli", 2);
    spawn.calls[0].child.emitLine(`${TS}Players online: 1/5`);
    spawn.calls[0].child.emitLine(`${TS}Slot 1: ${AUTH} "Jeff", latency: 42, level: surface,conn: LOCAL`);

    const res = await app.inject({ method: "GET", url: "/api/players" });
    expect(res.json().players).toMatchObject([{ auth: AUTH, latency: 42, level: "surface" }]);
  });
});

describe("commands", () => {
  async function running(): Promise<void> {
    await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
    spawn.calls[0].child.emitLine(F.READY_LINE_WITH_TS);
    // The roster's own reconcile fires here; clear it so assertions below are
    // about the command under test and nothing else.
    spawn.calls[0].child.written.length = 0;
  }

  it("serves the schema with both game versions, so the client can compare them", async () => {
    const res = await app.inject({ method: "GET", url: "/api/commands" });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.commands.length).toBeGreaterThan(80);
    expect(body.schemaGameVersion).toMatch(/^\d+\.\d+/);
    // Null until a server has run and reported one.
    expect(body).toHaveProperty("gameVersion");
  });

  it("sends a composed command to the server exactly once", async () => {
    await running();
    const res = await app.inject({
      method: "POST",
      url: "/api/command",
      payload: { name: "say", args: { message: "hello everyone" } },
    });
    expect(res.json()).toEqual({ ok: true, sent: "say hello everyone" });
    expect(spawn.calls[0].child.written).toEqual(["say hello everyone\n"]);
  });

  it("refuses a command that is not in the schema, and sends nothing", async () => {
    await running();
    const res = await app.inject({
      method: "POST",
      url: "/api/command",
      payload: { name: "stop", args: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a server command/i);
    expect(spawn.calls[0].child.written).toEqual([]);
  });

  it("refuses a bad argument, naming it, and sends nothing", async () => {
    await running();
    const res = await app.inject({
      method: "POST",
      url: "/api/command",
      payload: { name: "give", args: { item: "iron_bar", amount: "ten" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/amount/);
    expect(spawn.calls[0].child.written).toEqual([]);
  });

  it("refuses an injected second command, and sends nothing", async () => {
    await running();
    const res = await app.inject({
      method: "POST",
      url: "/api/command",
      payload: { name: "say", args: { message: "hi\nallowcheats" } },
    });
    expect(res.statusCode).toBe(400);
    expect(spawn.calls[0].child.written).toEqual([]);
  });

  it("refuses when there is no running server to send to", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/command",
      payload: { name: "players", args: {} },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not running/i);
  });

  it("rejects a malformed body rather than guessing what was meant", async () => {
    await running();
    const res = await app.inject({ method: "POST", url: "/api/command", payload: { args: {} } });
    expect(res.statusCode).toBe(400);
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

  // Steam is still asked once, for the workshop timestamp the install records -
  // that lookup is unconditional. What "never asks Steam" actually pins is
  // narrower: the NAME itself never comes from that call when one was supplied.
  it("prefers an explicitly supplied name over Steam's title", async () => {
    const install = vi.spyOn(installer, "install").mockResolvedValue({
      id: "3731244177",
      name: "My Own Name",
      jar: "x.jar",
      ok: true,
    });
    net.respondJson(detailsBody([{ id: "3731244177", title: "Steam's Title" }]));
    const res = await app.inject({
      method: "POST",
      url: "/api/mods",
      payload: { id: "3731244177", name: "My Own Name" },
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    expect(install.mock.calls[0][1]).toBe("My Own Name");
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

// The lookup runs unconditionally, even when a name is supplied explicitly -
// both tests below do, so the single Steam call each makes is unambiguously
// this one, not name resolution's.
describe("POST /api/mods records the workshop timestamp", () => {
  it("fetches the workshop entry and passes its timestamp to install", async () => {
    const install = vi.spyOn(installer, "install").mockResolvedValue({
      id: "3731244177",
      name: "Safe Haven QOL",
      jar: "SafeHavenQOL.jar",
      ok: true,
    });
    net.respondJson(
      detailsBody([{ id: "3731244177", title: "Safe Haven QOL", timeUpdated: 1_700_000_000 }]),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/mods",
      payload: { id: "3731244177", name: "Safe Haven QOL" },
    });

    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    expect(install.mock.calls[0][3]).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  // The one deliberate absorbed failure in this feature: losing the install
  // over a badge-grade lookup would be the worse trade, so a Steam failure
  // here records "unknown" rather than failing the request.
  it("records unknown, and still installs, when the workshop lookup fails", async () => {
    const install = vi.spyOn(installer, "install").mockResolvedValue({
      id: "3731244177",
      name: "Safe Haven QOL",
      jar: "SafeHavenQOL.jar",
      ok: true,
    });
    net.failWith("getaddrinfo ENOTFOUND api.steampowered.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/mods",
      payload: { id: "3731244177", name: "Safe Haven QOL" },
    });

    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    expect(install.mock.calls[0][3]).toBeNull();
  });
});

/*
 * Kept out of GET /api/mods on purpose: that list comes off disk and has to
 * survive Steam being down, so the badge data is a second call and an outage
 * costs badges rather than the mod list.
 */
describe("GET /api/mods/updates", () => {
  const installed = async (
    id: string,
    name: string,
    lastUpdated: string,
    workshopUpdatedAt: string | null = null,
  ): Promise<void> =>
    registry.upsert({ id, name, jar: `${name}.jar`, lastUpdated, workshopUpdatedAt });

  it("flags a mod whose workshop entry changed after it was installed", async () => {
    // The badge compares Steam's clock to the Steam clock we recorded, so what
    // decides these two is workshopUpdatedAt, not lastUpdated: 111 was
    // installed from an entry Steam has since moved, 222 from the entry Steam
    // still reports.
    await installed("111", "Old Local Name", "2026-01-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
    await installed("222", "Current", "2026-06-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
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

  it("claims no update for an entry Steam carries but cannot date", async () => {
    // The entry is on the workshop, so this is not the unknown-id case, but
    // Steam sent no time_updated. There is nothing to compare against, and
    // "unknown" is not an installable update. Update All still retries it -
    // the asymmetry runs that way on purpose.
    await installed("111", "Undated", "2026-01-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
    net.respondJson(detailsBody([{ id: "111", title: "Undated", timeUpdated: 0 }]));
    const [mod] = (await app.inject({ method: "GET", url: "/api/mods/updates" })).json().mods;
    expect(mod).toMatchObject({ onWorkshop: true, workshopUpdatedAt: null, updateAvailable: false });
  });

  it("does not badge a mod that Update All would skip", async () => {
    await registry.upsert({
      id: "3731244177",
      name: "Safe Haven QOL",
      jar: "SafeHavenQOL.jar",
      lastUpdated: "2026-07-01T00:00:00.000Z",
      workshopUpdatedAt: "2026-07-20T10:00:00.000Z",
    });
    // Steam reports exactly what we recorded, but the entry changed AFTER our
    // install wall-clock time. The old comparison badged this; the gate skips it.
    net.respondJson(
      detailsBody([
        {
          id: "3731244177",
          title: "Safe Haven QOL",
          timeUpdated: Math.floor(Date.parse("2026-07-20T10:00:00.000Z") / 1000),
        },
      ]),
    );

    const res = await app.inject({ method: "GET", url: "/api/mods/updates" });
    expect(res.json().mods[0].updateAvailable).toBe(false);
  });

  it("badges a mod whose entry moved since the jar we installed", async () => {
    await registry.upsert({
      id: "3731244177",
      name: "Safe Haven QOL",
      jar: "SafeHavenQOL.jar",
      lastUpdated: "2026-07-01T00:00:00.000Z",
      workshopUpdatedAt: "2026-07-20T10:00:00.000Z",
    });
    net.respondJson(
      detailsBody([
        {
          id: "3731244177",
          title: "Safe Haven QOL",
          timeUpdated: Math.floor(Date.parse("2026-07-21T10:00:00.000Z") / 1000),
        },
      ]),
    );

    const res = await app.inject({ method: "GET", url: "/api/mods/updates" });
    expect(res.json().mods[0].updateAvailable).toBe(true);
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
 * Per-world mod sets, the library they are chosen from, and the reconcile that
 * makes the mods folder match the set the instant before the game reads it.
 *
 * The jars here are real zips with real `mod.info` entries (see
 * `fixtures/mod-jar.ts`), not stubs: the whole feature turns on reading a real
 * jar, so a test that faked the zip layer would prove nothing about it.
 */
describe("mod library and per-world sets", () => {
  /** A jar in the mods folder, as steamcmd or a person's file explorer would leave it. */
  const installJar = (
    filename: string,
    fields: Parameters<typeof makeModJar>[2],
  ): Promise<string> => makeModJar(cfg.modsDir, filename, fields);

  const upload = (
    bytes: Buffer,
    filename?: string,
    type = "application/java-archive",
  ): Promise<Injected> =>
    app.inject({
      method: "POST",
      url: `/api/mods/upload${filename === undefined ? "" : `?filename=${encodeURIComponent(filename)}`}`,
      headers: { "content-type": type },
      payload: bytes,
    });

  const jarsInMods = async (): Promise<string[]> =>
    (await readdir(cfg.modsDir)).filter((f) => f.endsWith(".jar")).sort();

  describe("GET /api/mods/library", () => {
    it("is empty before anything has been put in it", async () => {
      const res = await app.inject({ method: "GET", url: "/api/mods/library" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, mods: [] });
    });

    it("lists what a jar's own mod.info says, and where the jar came from", async () => {
      await library.add(
        await makeModJar(join(cfg.modsDir, "..", "incoming"), "SummonerExpansion-1.2.0-7.7.jar", {}, {
          info: MOD_INFO_SUMMONER_EXPANSION,
        }),
        { kind: "local", how: "adopted" },
      );

      const [mod] = (await app.inject({ method: "GET", url: "/api/mods/library" })).json().mods;

      expect(mod).toMatchObject({
        id: "gagadoliano.summonerexpansion",
        name: "Summoner Expansion",
        version: "7.7",
        gameVersion: "1.2.0",
        author: "Gagadoliano",
        jar: "SummonerExpansion-1.2.0-7.7.jar",
        source: { kind: "local", how: "adopted" },
      });
    });
  });

  describe("POST /api/mods/upload", () => {
    it("takes a real jar into the library and reports what it is", async () => {
      const bytes = await modJarBytes({
        id: "someone.newmod",
        name: "New Mod",
        version: "3.1",
        gameVersion: "1.2.0",
      });

      const res = await upload(bytes, "NewMod-3.1.jar");

      expect(res.statusCode).toBe(200);
      expect(res.json().mod).toMatchObject({
        id: "someone.newmod",
        name: "New Mod",
        version: "3.1",
        jar: "NewMod-3.1.jar",
        source: { kind: "local", how: "upload" },
      });
      expect(res.json().replaced).toBe(false);
      const held = await library.resolve("someone.newmod");
      expect(await readFile(held!.path)).toEqual(bytes);
      // The library, never the folder the game reads. An upload must not change
      // what a running or a stopped server would load.
      expect(await jarsInMods()).toEqual([]);
    });

    it("says so when it replaced an existing jar, and keeps the one it replaced", async () => {
      const first = await modJarBytes({ id: "a.b", version: "1" });
      await upload(first, "A-1.jar");

      const res = await upload(await modJarBytes({ id: "a.b", version: "2" }), "A-2.jar");

      expect(res.json().replaced).toBe(true);
      expect((await library.load()).map((m) => m.version)).toEqual(["2"]);
      // Superseded, never deleted: an uploaded jar may be the only copy there is.
      const entry = (await library.get("a.b"))!;
      expect(entry.superseded.map((j) => j.jar)).toEqual(["A-1.jar"]);
      expect(await readFile(library.jarPath(entry, "A-1.jar"))).toEqual(first);
    });

    it("refuses a filename Windows cannot make a file out of", async () => {
      for (const name of ["CON.jar", "con.jar", ".jar", "  .jar"]) {
        const res = await upload(await modJarBytes({ id: "a.b" }), name);
        expect(res.statusCode, name).toBe(400);
      }
      expect(await library.load()).toEqual([]);
    });

    /*
     * The two refusals that must happen before a byte is written. An
     * unauthenticated LAN endpoint that wrote first and checked afterwards
     * would be a way to put arbitrary files on this box.
     */
    it("refuses an oversize jar, writing nothing", async () => {
      // One byte over the configured limit: large enough to be refused, small
      // enough to still reach this route rather than being cut off in transit.
      const res = await upload(Buffer.alloc(cfg.modUploadMaxBytes + 1, 7), "Huge.jar");

      expect(res.statusCode).toBe(413);
      expect(res.json().error).toMatch(/upload limit/);
      expect(res.json().error).toMatch(/Nothing was written/);
      expect(await library.load()).toEqual([]);
    });

    it("cuts off a wildly oversize body rather than holding it in memory", async () => {
      const res = await upload(Buffer.alloc(cfg.modUploadMaxBytes * 4, 7), "Huge.jar");
      expect(res.statusCode).toBe(413);
      expect(await library.load()).toEqual([]);
    });

    it("refuses a jar with no mod.info, saying it is not a Necesse mod, and writes nothing", async () => {
      const bytes = await modJarBytes({ id: "irrelevant" }, { omitInfo: true });

      const res = await upload(bytes, "NotAMod.jar");

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/no mod\.info at its root/);
      expect(await library.load()).toEqual([]);
      await expect(readdir(cfg.modLibraryDir)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses a mod.info with no id", async () => {
      const res = await upload(await modJarBytes({ name: "Nameless" }), "Nameless.jar");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/no "id" line/);
      expect(await library.load()).toEqual([]);
    });

    it("refuses a filename that is a path rather than a name", async () => {
      const res = await upload(await modJarBytes({ id: "a.b" }), "..\\..\\Server.jar");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/not a plain filename/);
      expect(await library.load()).toEqual([]);
    });

    it("refuses an empty body rather than storing nothing under a mod's name", async () => {
      const res = await upload(Buffer.alloc(0), "Empty.jar");
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Nothing was uploaded/);
    });

    it("names the jar after the mod when no filename is given", async () => {
      const res = await upload(await modJarBytes({ id: "a.b", version: "1" }));
      expect(res.statusCode).toBe(200);
      expect(res.json().mod.jar).toBe("a.b.jar");
    });

    it("accepts the other content types a client might reasonably send", async () => {
      for (const type of ["application/octet-stream", "application/zip"]) {
        const res = await upload(await modJarBytes({ id: `a.${type.length}` }), "A.jar", type);
        expect(res.statusCode, type).toBe(200);
      }
    });

    it("refuses while a background task is rewriting the same library", async () => {
      await app.inject({ method: "POST", url: "/api/server/update" });
      const res = await upload(await modJarBytes({ id: "a.b" }), "A.jar");
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/background task/i);
      expect(await library.load()).toEqual([]);
    });

    it("releases its slot on every path out, including the refusals", async () => {
      await upload(await modJarBytes({ id: "irrelevant" }, { omitInfo: true }), "NotAMod.jar");
      expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([]);
      await upload(await modJarBytes({ id: "a.b" }), "A.jar");
      expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([]);
    });
  });

  describe("GET and PUT /api/worlds/:name/mods", () => {
    const getSet = (world: string): Promise<Injected> =>
      app.inject({ method: "GET", url: `/api/worlds/${encodeURIComponent(world)}/mods` });

    const putSet = (world: string, payload: object): Promise<Injected> =>
      app.inject({ method: "PUT", url: `/api/worlds/${encodeURIComponent(world)}/mods`, payload });

    it("reports a world nobody has chosen a set for as unconfigured, not as empty", async () => {
      const res = await getSet("Tulsa");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ modIds: [], missing: [], configured: false });
    });

    /*
     * An unconfigured world would start with whatever is installed right now,
     * because that is what `start` seeds its set from. Reporting an empty list
     * read as "this world loads no mods" while it was about to load eight;
     * `configured` is what says the choice has not been made yet.
     */
    it("reports what start would seed an unconfigured world with, not an empty list", async () => {
      await installJar("A-1.jar", { id: "x.a", version: "1" });
      await installJar("B-1.jar", { id: "x.b", version: "1" });

      const res = await getSet("Never Started");

      expect(res.json().configured).toBe(false);
      expect([...res.json().modIds].sort()).toEqual(["x.a", "x.b"]);
      // Nothing was written by reading: it is still unconfigured afterwards.
      expect(await sets.get("Never Started")).toBeUndefined();
    });

    it("answers with the same refusal start would, when the folder holds a jar it cannot account for", async () => {
      await makeNonModJar(cfg.modsDir, "Mystery.jar");
      const res = await getSet("Never Started");
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/Mystery\.jar/);
    });

    it("writes a set and reads it back", async () => {
      await upload(await modJarBytes({ id: "a.one" }), "A.jar");
      await upload(await modJarBytes({ id: "b.two" }), "B.jar");

      const put = await putSet("Tulsa", { modIds: ["a.one", "b.two"] });

      expect(put.statusCode).toBe(200);
      expect(put.json().modIds).toEqual(["a.one", "b.two"]);
      expect((await getSet("Tulsa")).json()).toMatchObject({
        modIds: ["a.one", "b.two"],
        configured: true,
      });
    });

    // Windows world names are case-insensitive and listWorlds reads them off
    // disk, so a set must not be findable only in the case it was written in.
    it("finds a world's set whatever case it is asked for", async () => {
      await upload(await modJarBytes({ id: "a.one" }), "A.jar");
      await putSet("Summoner World", { modIds: ["a.one"] });
      expect((await getSet("summoner world")).json().modIds).toEqual(["a.one"]);
      expect((await getSet("SUMMONER WORLD")).json().configured).toBe(true);
    });

    /*
     * A set may only name mods the library holds, so that a world can never be
     * saved into a state that would then refuse to start.
     */
    it("refuses an id the library has no jar for, naming it", async () => {
      await upload(await modJarBytes({ id: "a.one" }), "A.jar");
      const res = await putSet("Tulsa", { modIds: ["a.one", "not.here"] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/not\.here/);
      expect((await getSet("Tulsa")).json().configured).toBe(false);
    });

    it("rejects a body that is not a list of ids", async () => {
      for (const payload of [{}, { modIds: "a.one" }, { modIds: [1, 2] }, { modIds: [""] }]) {
        const res = await putSet("Tulsa", payload);
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json().error).toMatch(/modIds/);
      }
    });

    it("refuses a world name that could escape the worlds directory", async () => {
      for (const name of ["a/b", "a|b", "..\\..\\Server"]) {
        expect((await getSet(name)).statusCode, name).toBe(400);
        expect((await putSet(name, { modIds: [] })).statusCode, name).toBe(400);
      }
    });

    // Editing a set writes no jars, so it is allowed while the server is up; it
    // takes effect at that world's next start, because the game reads its mods
    // once, at startup.
    it("is allowed while the server is running", async () => {
      await upload(await modJarBytes({ id: "a.one" }), "A.jar");
      await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
      spawn.calls[0].child.emitLine(F.READY_LINE_WITH_TS);
      expect((await putSet("Later World", { modIds: ["a.one"] })).statusCode).toBe(200);
    });

    it("reports an id the library has since lost, so the refusal to start is not a surprise", async () => {
      await upload(await modJarBytes({ id: "a.one" }), "A.jar");
      await putSet("Tulsa", { modIds: ["a.one"] });
      await library.remove("a.one");
      expect((await getSet("Tulsa")).json().missing).toEqual(["a.one"]);
    });
  });

  describe("POST /api/mods/reconcile", () => {
    it("makes the mods folder hold exactly the world's set", async () => {
      await installJar("Old-1.jar", { id: "x.old", version: "1" });
      await upload(await modJarBytes({ id: "x.new", version: "2" }), "New-2.jar");
      await app.inject({
        method: "PUT",
        url: "/api/worlds/Tulsa/mods",
        payload: { modIds: ["x.new"] },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/mods/reconcile",
        payload: { world: "Tulsa" },
      });

      expect(res.statusCode).toBe(200);
      expect(await jarsInMods()).toEqual(["New-2.jar"]);
      // Adopt before prune: the jar it removed is still restorable.
      expect(res.json().reconcile.adopted).toEqual(["Old-1.jar"]);
      expect(await library.resolve("x.old")).toBeDefined();
    });

    // It rewrites the folder the game reads its mod set from, so it is refused
    // exactly like every other mutation of that folder.
    it("refuses while the server is running or still starting", async () => {
      await installJar("A-1.jar", { id: "x.a", version: "1" });
      await app.inject({ method: "POST", url: "/api/server/start", payload: { world: "Tulsa" } });
      const before = await jarsInMods();

      const starting = await app.inject({
        method: "POST",
        url: "/api/mods/reconcile",
        payload: { world: "Tulsa" },
      });
      expect(starting.statusCode).toBe(409);
      expect(starting.json().error).toMatch(/starting/);

      spawn.calls[0].child.emitLine(F.READY_LINE_WITH_TS);
      const running = await app.inject({
        method: "POST",
        url: "/api/mods/reconcile",
        payload: { world: "Tulsa" },
      });
      expect(running.statusCode).toBe(409);
      expect(running.json().error).toMatch(/running/);
      expect(await jarsInMods()).toEqual(before);
    });

    it("refuses while a background task is in flight, and works once it clears", async () => {
      await app.inject({ method: "POST", url: "/api/server/update" });

      const blocked = await app.inject({
        method: "POST",
        url: "/api/mods/reconcile",
        payload: { world: "Tulsa" },
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toMatch(/background task/i);

      spawn.calls[0].child.exit(0);
      await vi.waitFor(async () => {
        expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([]);
      });
      const allowed = await app.inject({
        method: "POST",
        url: "/api/mods/reconcile",
        payload: { world: "Tulsa" },
      });
      expect(allowed.statusCode).toBe(200);
    });

    it("holds a slot in activeTasks while it runs and releases it afterwards", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/mods/reconcile",
        payload: { world: "Tulsa" },
      });
      expect(res.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([]);
    });

    it("rejects an invalid world name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/mods/reconcile",
        payload: { world: "bad:name" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/server/start reconciles first", () => {
    it("brings the folder to the set before the game is spawned", async () => {
      await installJar("Unwanted-1.jar", { id: "x.unwanted", version: "1" });
      await upload(await modJarBytes({ id: "x.wanted", version: "1" }), "Wanted-1.jar");
      await sets.set("Tulsa", ["x.wanted"]);

      const res = await app.inject({
        method: "POST",
        url: "/api/server/start",
        payload: { world: "Tulsa" },
      });

      expect(res.statusCode).toBe(200);
      expect(await jarsInMods()).toEqual(["Wanted-1.jar"]);
      expect(spawn.calls).toHaveLength(1);
    });

    /*
     * The refusal that matters most. Launching with a mod missing would have
     * the game silently run a set nobody chose and write it into the save, so
     * the server is not started at all.
     */
    it("refuses to start when the set names a mod the library has lost, and spawns nothing", async () => {
      await sets.set("Tulsa", ["x.vanished"]);

      const res = await app.inject({
        method: "POST",
        url: "/api/server/start",
        payload: { world: "Tulsa" },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/x\.vanished/);
      expect(res.json().error).toMatch(/was not started/);
      expect(spawn.calls).toHaveLength(0);
      expect(pm.status.state).toBe("stopped");
      // The slot it claimed for the attempt is released either way.
      expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([]);
    });

    it("refuses, and leaves the folder alone, when it holds a jar it cannot account for", async () => {
      await makeNonModJar(cfg.modsDir, "Mystery.jar");
      await sets.set("Tulsa", []);

      const res = await app.inject({
        method: "POST",
        url: "/api/server/start",
        payload: { world: "Tulsa" },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/Mystery\.jar/);
      expect(await jarsInMods()).toEqual(["Mystery.jar"]);
      expect(spawn.calls).toHaveLength(0);
    });

    /*
     * A world typed into the header field for the first time has no set. It
     * inherits exactly what is installed right now, so its first start loads
     * what the folder already held - the same rule the migration applies.
     */
    it("seeds a set from what is installed for a world that has none", async () => {
      await installJar("A-1.jar", { id: "x.a", version: "1" });

      const res = await app.inject({
        method: "POST",
        url: "/api/server/start",
        payload: { world: "Brand New" },
      });

      expect(res.statusCode).toBe(200);
      expect((await sets.get("Brand New"))?.modIds).toEqual(["x.a"]);
      expect(await jarsInMods()).toEqual(["A-1.jar"]);
    });

    /*
     * Two mods whose jars are named the same thing cannot both be in the folder.
     * `verify` catches the result, but its message ("some mod is not there")
     * leaves an unstartable world with no actionable diagnosis - so the
     * collision is detected by name, before anything is written.
     */
    it("refuses with both mod ids and the shared filename when two jars collide", async () => {
      await upload(await modJarBytes({ id: "a.one" }), "mod.jar");
      await upload(await modJarBytes({ id: "b.two" }), "mod.jar");
      await sets.set("Tulsa", ["a.one", "b.two"]);

      const res = await app.inject({
        method: "POST",
        url: "/api/server/start",
        payload: { world: "Tulsa" },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/a\.one/);
      expect(res.json().error).toMatch(/b\.two/);
      expect(res.json().error).toMatch(/mod\.jar/);
      expect(spawn.calls).toHaveLength(0);
      expect(await jarsInMods()).toEqual([]);
    });

    it("does not rewrite the mods folder for a start that was never going to be allowed", async () => {
      await installJar("A-1.jar", { id: "x.a", version: "1" });
      await sets.set("Tulsa", []);
      pm.markUnmanaged(4321);

      const res = await app.inject({
        method: "POST",
        url: "/api/server/start",
        payload: { world: "Tulsa" },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/unmanaged/i);
      // Refused before reconciling, so the folder is untouched.
      expect(await jarsInMods()).toEqual(["A-1.jar"]);
    });
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

    // Observed on a real world on this box: a mod writes a key and leaves the
    // value blank. GET has to report it, or the field count silently disagrees
    // with the file.
    it("reports a key a mod left with an empty value", async () => {
      const cfgText = `${WORLD_SETTINGS_CFG.slice(0, -2)},\n\tIncreasedStackSize = \n}`;
      await makeWorldZip(cfg.worldsDir, "Test Ville", { cfg: cfgText });

      const fields = await fieldsOf("Test Ville");
      expect(fields).toHaveLength(19);
      expect(fields[18]).toMatchObject({
        key: "IncreasedStackSize",
        value: "",
        type: null,
        editable: false,
      });
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

    /*
     * Two clients saving the same world at once used to both get a 200 with one
     * edit silently gone: both passed the guard, both rebuilt from the same
     * starting text, and the second rename discarded the first one's work. The
     * write now claims a slot in the same `activeTasks` set every other
     * mutation consults, so the second caller is refused with the same 409.
     *
     * The world here carries several megabytes of incompressible payload so the
     * save is genuinely still running when the second request arrives - the
     * point is to catch a real overlap, not to assert against a save that had
     * already finished.
     */
    it("refuses a second write while one is still in flight, losing no edit", async () => {
      const busyWorld = "Busy World";
      const busyZip = await makeWorldZip(cfg.worldsDir, busyWorld, { bulkBytes: 6 * 1024 * 1024 });

      const first = put({ difficulty: "HARD" }, busyWorld);
      await vi.waitFor(async () => {
        const status = await app.inject({ method: "GET", url: "/api/status" });
        expect(status.json().activeTasks).toHaveLength(1);
      });

      // Mid-save: a second write is refused, and so is launching the game
      // against the world being replaced.
      const second = await put({ difficulty: "BRUTAL" }, busyWorld);
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toMatch(/world settings write/);
      const start = await app.inject({
        method: "POST",
        url: "/api/server/start",
        payload: { world: "Tulsa" },
      });
      expect(start.statusCode).toBe(409);
      expect(spawn.calls).toHaveLength(0);

      expect((await first).statusCode).toBe(200);
      // Exactly one edit survived, and it is the one that was accepted.
      const open = await openWorldSettings(busyZip);
      expect(open.file.get("difficulty")).toBe("HARD");
      // The slot is released, so the next write goes through normally.
      expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([]);
      expect((await put({ difficulty: "BRUTAL" }, busyWorld)).statusCode).toBe(200);
    });

    it("releases its slot even when the write is refused", async () => {
      for (const payload of [{ notAField: 1 }, { maxSettlersPerSettlement: 5 }]) {
        expect((await put(payload)).statusCode).toBe(400);
        expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([]);
      }
      expect((await put({ allowCheats: true }, "No Such World")).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/status" })).json().activeTasks).toEqual([]);
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

describe("access token", () => {
  beforeEach(() => {
    cfg.authToken = "s3cret";
    app = buildServer({
      cfg,
      configFile,
      configWarnings: [],
      pm,
      installer,
      library,
      sets,
      steam,
      workshop,
      launchOptions,
      playerRoster,
    });
  });

  it("rejects a request with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/status" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/token/i);
  });

  it("rejects a wrong token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: "Bearer nope" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts the right token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(res.statusCode).toBe(200);
  });

  // Named for what it can actually observe. @fastify/cors answers a valid
  // preflight in its own onRequest hook and short-circuits, so this passes
  // identically with the auth hook's OPTIONS exemption deleted - it pins that
  // a preflight is answered at all, not which hook exempted it.
  it("answers a CORS preflight, which cannot carry an Authorization header", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/status",
      headers: {
        origin: "http://tauri.localhost",
        "access-control-request-method": "GET",
      },
    });
    expect(res.statusCode).toBeLessThan(400);
  });

  it("never returns the token from GET /api/config", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/config",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(JSON.stringify(res.json())).not.toContain("s3cret");
    expect(res.json().authRequired).toBe(true);
  });

  // The defect this pins: authRequired and the hook itself must agree on what
  // "configured" means. Without trimming both, a whitespace-only token would
  // report authRequired: false (nothing to send) while still 401ing every
  // request, or the reverse - either way the operator has no usable fix.
  it("treats a whitespace-only token as unset, in both the hook and the reported flag", async () => {
    cfg.authToken = "   ";
    const whitespaceApp = buildServer({
      cfg,
      configFile,
      configWarnings: [],
      pm,
      installer,
      library,
      sets,
      steam,
      workshop,
      launchOptions,
      playerRoster,
    });

    const status = await whitespaceApp.inject({ method: "GET", url: "/api/status" });
    expect(status.statusCode).toBe(200);

    const config = await whitespaceApp.inject({ method: "GET", url: "/api/config" });
    expect(config.json().authRequired).toBe(false);
  });

  // Not just "no token 401s" - that alone would pass identically if the route
  // did not exist at all, since the auth hook 401s any path before routing
  // gets a chance to 404 it. Asserting the right token actually reaches a real
  // 200 is what proves the route (and the auth check in front of it) both
  // exist, rather than just proving the hook itself works.
  it("rejects a launch-options request with no token, and serves it with the right one", async () => {
    const noToken = await app.inject({ method: "GET", url: "/api/launch-options" });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json().error).toMatch(/token/i);

    const withToken = await app.inject({
      method: "GET",
      url: "/api/launch-options",
      headers: { authorization: "Bearer s3cret" },
    });
    expect(withToken.statusCode).toBe(200);
  });
});

describe("launch options", () => {
  it("serves the defaults with the field list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/launch-options" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.world).toBeNull();
    expect(Array.isArray(body.fields)).toBe(true);
    expect(body.fields.some((f: { name: string }) => f.name === "owner")).toBe(true);
  });

  it("never offers a daemon-owned argument as a field", async () => {
    const res = await app.inject({ method: "GET", url: "/api/launch-options" });
    const names = res.json().fields.map((f: { name: string }) => f.name);
    // Self-supporting: without this an empty field list would trivially
    // "never offer" a forbidden name too. Asserting real, allowed fields are
    // present is what makes the negative check below mean something.
    expect(names).toEqual(expect.arrayContaining(["owner", "slots", "port"]));
    for (const forbidden of ["datadir", "world", "nogui"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("stores a default and reports it as effective for a world", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/launch-options",
      payload: { owner: "Jeff" },
    });
    expect(put.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/api/worlds/Tulsa/launch-options" });
    expect(res.json().effective).toEqual({ owner: "Jeff" });
    expect(res.json().overrides).toEqual({});
  });

  it("lets a world override a default", async () => {
    await app.inject({ method: "PUT", url: "/api/launch-options", payload: { owner: "Jeff" } });
    await app.inject({
      method: "PUT",
      url: "/api/worlds/Tulsa/launch-options",
      payload: { owner: "Eli" },
    });
    const res = await app.inject({ method: "GET", url: "/api/worlds/Tulsa/launch-options" });
    expect(res.json().effective.owner).toBe("Eli");
    expect(res.json().defaults.owner).toBe("Jeff");
  });

  it("clears an override with null", async () => {
    await app.inject({ method: "PUT", url: "/api/launch-options", payload: { slots: 5 } });
    await app.inject({ method: "PUT", url: "/api/worlds/Tulsa/launch-options", payload: { slots: 20 } });
    await app.inject({ method: "PUT", url: "/api/worlds/Tulsa/launch-options", payload: { slots: null } });
    const res = await app.inject({ method: "GET", url: "/api/worlds/Tulsa/launch-options" });
    expect(res.json().overrides).toEqual({});
    expect(res.json().effective).toEqual({ slots: 5 });
  });

  it("refuses an out-of-range value naming the limit, and stores nothing", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/worlds/Tulsa/launch-options",
      payload: { slots: 999 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/1 and 250/);
    const after = await app.inject({ method: "GET", url: "/api/worlds/Tulsa/launch-options" });
    expect(after.json().overrides).toEqual({});
  });

  // Without this, an illegal name like a whitespace-only or a colon-bearing
  // one is accepted and stored under `normaliseWorld`'s trimmed key - which
  // `POST /api/server/start` (isValidWorldName-gated) can never look up by
  // that same illegal name - so the write would be saved, echoed back as
  // saved, and silently never applied. Every sibling `/api/worlds/:name/*`
  // route already refuses this; these two must match it.
  it("refuses an invalid world name on both the GET and the PUT", async () => {
    const getRes = await app.inject({ method: "GET", url: "/api/worlds/bad%3Aname/launch-options" });
    expect(getRes.statusCode).toBe(400);
    expect(getRes.json().error).toMatch(/world name/i);

    const putRes = await app.inject({
      method: "PUT",
      url: "/api/worlds/bad%3Aname/launch-options",
      payload: { owner: "Jeff" },
    });
    expect(putRes.statusCode).toBe(400);
    expect(putRes.json().error).toMatch(/world name/i);
  });

  it("refuses an unknown option rather than ignoring it", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/worlds/Tulsa/launch-options",
      payload: { nosuchthing: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a known/i);
  });

  it("refuses a daemon-owned argument", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/worlds/Tulsa/launch-options",
      payload: { datadir: "C:\\evil" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a known/i);
  });

  // The game joins the whole command line into one string before parsing it,
  // so a text value carrying a word that starts with `-` is re-read as a flag:
  // `-owner "-settings C:/evil.cfg"` stores owner as empty AND sets `settings`,
  // which is deliberately not on offer here, on a daemon running as SYSTEM.
  // The name filter cannot see this at all; only value validation can.
  it("refuses a text value the game's parser would read as another flag", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/worlds/Tulsa/launch-options",
      payload: { owner: "-settings C:/evil.cfg" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/starts a new option/i);

    const after = await app.inject({ method: "GET", url: "/api/worlds/Tulsa/launch-options" });
    expect(after.json().overrides).toEqual({});
  });

  it("rejects the whole payload when one value is bad", async () => {
    // All-or-nothing: a partial apply would leave the operator looking at a
    // form where some edits took and some did not, with one error to explain it.
    const res = await app.inject({
      method: "PUT",
      url: "/api/worlds/Tulsa/launch-options",
      payload: { owner: "Jeff", slots: 999 },
    });
    expect(res.statusCode).toBe(400);
    const after = await app.inject({ method: "GET", url: "/api/worlds/Tulsa/launch-options" });
    expect(after.json().overrides).toEqual({});
  });

  it("starts the server with the world's effective launch options", async () => {
    await app.inject({ method: "PUT", url: "/api/launch-options", payload: { owner: "Jeff" } });
    await app.inject({
      method: "PUT",
      url: "/api/worlds/Tulsa/launch-options",
      payload: { slots: 12 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/server/start",
      payload: { world: "Tulsa" },
    });
    expect(res.statusCode).toBe(200);
    // Adjacency, not just presence: `-owner` and `Jeff` each showing up
    // somewhere in argv would also pass for a command line that put every
    // flag first and every value after, which is not a command line the game
    // would parse correctly.
    //
    // Accepted as-is for these two values, but do NOT copy the technique for a
    // free-text value: joining argv on " " and substring-matching cannot tell
    // ["-motd", "x -owner Eli"] from ["-motd", "x", "-owner", "Eli"], so a
    // value containing a space would make it assert about a command line that
    // is not the one being built. Index-based adjacency is the correct form,
    // as in daemon/test/process-manager.test.ts's buildArgs tests:
    //   expect(argv[argv.indexOf("-owner") + 1]).toBe("Jeff")
    const argv = spawn.calls[0].args.join(" ");
    expect(argv).toContain("-owner Jeff");
    expect(argv).toContain("-slots 12");
  });

  // The load-bearing requirement: a broken launch-options.json must fail the
  // start outright rather than silently starting with zero options, which
  // would be the same silent-success shape (world loads, launch reports
  // success, nobody holds owner) this whole feature exists to prevent.
  it("refuses to start the server when launch options cannot be read, rather than starting with none", async () => {
    const broken = new LaunchOptions(join(cfg.worldsDir, "..", "launch-options.json"));
    await mkdir(join(cfg.worldsDir, ".."), { recursive: true });
    await writeFile(join(cfg.worldsDir, "..", "launch-options.json"), "{not json");
    const brokenApp = buildServer({
      cfg,
      configFile,
      configWarnings: [],
      pm,
      installer,
      library,
      sets,
      steam,
      workshop,
      launchOptions: broken,
      playerRoster,
    });

    const res = await brokenApp.inject({
      method: "POST",
      url: "/api/server/start",
      payload: { world: "Tulsa" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/launch-options\.json/);
    expect(spawn.calls).toHaveLength(0);
  });
});
