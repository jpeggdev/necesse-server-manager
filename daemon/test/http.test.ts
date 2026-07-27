import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer, TASK_EXPIRY_MS } from "../src/http.js";
import { ProcessManager } from "../src/process-manager.js";
import { ModInstaller } from "../src/mod-installer.js";
import { ModRegistry } from "../src/mod-registry.js";
import { SteamCmd } from "../src/steamcmd.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { makeFakeSpawn } from "./fixtures/fake-spawn.js";
import type { DaemonConfig, WsMessage } from "../src/types.js";
import * as F from "./fixtures/log-fixtures.js";

let cfg: DaemonConfig;
let configFile: string;
let spawn: ReturnType<typeof makeFakeSpawn>;
let pm: ProcessManager;
let installer: ModInstaller;
let steam: SteamCmd;
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
  installer = new ModInstaller(cfg, new ModRegistry(join(root, "mods.json")), steam);
  app = buildServer({ cfg, configFile, pm, installer, steam });
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
    const selfHealApp = buildServer({ cfg, configFile, pm: deadPm, installer, steam });

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
    const rejectApp = buildServer({ cfg, configFile, pm, installer, steam: throwingSteam });

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

  it("rejects a blank name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mods",
      payload: { id: "123", name: "  " },
    });
    expect(res.statusCode).toBe(400);
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
});
