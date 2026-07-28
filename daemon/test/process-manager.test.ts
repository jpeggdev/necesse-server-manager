import { describe, it, expect, beforeEach } from "vitest";
import { ProcessManager } from "../src/process-manager.js";
import { makeFakeSpawn, type SpawnRecord } from "./fixtures/fake-spawn.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { DaemonConfig } from "../src/types.js";
import * as F from "./fixtures/log-fixtures.js";

const cfg: DaemonConfig = { ...DEFAULT_CONFIG, owners: ["Jeff", "Eli"], stopTimeoutMs: 50 };

let spawn: ReturnType<typeof makeFakeSpawn>;
let pm: ProcessManager;

beforeEach(() => {
  spawn = makeFakeSpawn();
  pm = new ProcessManager(cfg, spawn.spawn);
});

const child = (): SpawnRecord => spawn.calls[0];

const esrch = (): never => {
  const e = new Error("kill ESRCH") as NodeJS.ErrnoException;
  e.code = "ESRCH";
  throw e;
};
const eperm = (): never => {
  const e = new Error("kill EPERM") as NodeJS.ErrnoException;
  e.code = "EPERM";
  throw e;
};
/** Signal 0 succeeding (no throw) is exactly what a live pid looks like. */
const alive = (): void => {};

describe("buildArgs", () => {
  it("puts jvm args before -jar and one -owner per configured owner", () => {
    const args = pm.buildArgs("Infected Toenail");
    expect(args).toEqual([
      ...cfg.jvmArgs,
      "-jar",
      cfg.serverJar,
      "-nogui",
      "-datadir",
      cfg.dataDir,
      "-world",
      "Infected Toenail",
      "-owner",
      "Jeff",
      "-owner",
      "Eli",
    ]);
  });

  /*
   * Without -datadir the server derives its saves and mods from the running
   * account's APPDATA, which is what tied the daemon to an interactive jeffp
   * logon: as SYSTEM it would silently resolve
   * C:\Windows\system32\config\systemprofile\AppData\Roaming\Necesse and start
   * with no worlds and no mods, reporting success the whole way. This asserts
   * the flag is passed and carries the configured directory verbatim - a value
   * dropped or defaulted here is invisible until a real launch.
   */
  it("hands the game its data directory explicitly, before the world that lives in it", () => {
    const args = pm.buildArgs("Tulsa");
    const at = args.indexOf("-datadir");
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe(cfg.dataDir);
    expect(at).toBeLessThan(args.indexOf("-world"));
    // Still a JVM/-jar boundary: the game's own flags all follow the jar.
    expect(at).toBeGreaterThan(args.indexOf("-jar"));
  });

  it("passes a data directory containing spaces as one unsplit argument", () => {
    const spaced = "D:\\Game Data\\Necesse Server";
    const pm2 = new ProcessManager({ ...cfg, dataDir: spaced }, spawn.spawn);
    expect(pm2.buildArgs("Tulsa")).toContain(spaced);
  });
});

describe("start", () => {
  it("spawns java with the server root as cwd", () => {
    pm.start("Tulsa");
    expect(child().cmd).toBe(cfg.javaExe);
    expect(child().cwd).toBe(cfg.serverRoot);
  });

  it("enters starting, then running only on the ready line", () => {
    pm.start("Infected Toenail");
    expect(pm.status.state).toBe("starting");
    child().child.emitLine(F.MOD_FOUND);
    expect(pm.status.state).toBe("starting");
    child().child.emitLine(F.READY_LINE_WITH_TS);
    expect(pm.status.state).toBe("running");
  });

  it("drives the real coloured stdout, and strips the colour out of the backlog", () => {
    pm.start("Tulsa");
    child().child.emitLine(F.REAL_DEBUG);
    child().child.emitLine(F.REAL_READY);
    expect(pm.status.state).toBe("running");
    expect(pm.status.port).toBe(14159);
    // What the operator reads must not contain the escape.
    const backlog = pm.backlog.map((l) => l.line);
    expect(backlog[0]).toBe("[2026-07-27 03:27:26] (DEBUG) Initializing DesktopPlatform");
    expect(backlog.some((l) => l.includes(String.fromCharCode(27)))).toBe(false);
  });

  it("records port, slots, and version from the ready line", () => {
    pm.start("Infected Toenail");
    child().child.emitLine(F.READY_LINE_WITH_TS);
    expect(pm.status.port).toBe(14159);
    expect(pm.status.slots).toBe(5);
    expect(pm.status.gameVersion).toBe("1.2.0");
  });

  it("refuses to start when not stopped", () => {
    pm.start("Tulsa");
    expect(() => pm.start("Tulsa")).toThrow(/already/i);
    expect(spawn.calls).toHaveLength(1);
  });

  it("splits multi-line chunks and strips carriage returns", () => {
    const seen: string[] = [];
    pm.on("line", (l) => seen.push(l.line));
    pm.start("Tulsa");
    child().child.stdout.emit("data", Buffer.from("one\r\ntwo\r\n"));
    expect(seen).toEqual(["one", "two"]);
  });

  it("buffers a partial line until its newline arrives", () => {
    const seen: string[] = [];
    pm.on("line", (l) => seen.push(l.line));
    pm.start("Tulsa");
    child().child.stdout.emit("data", Buffer.from("par"));
    expect(seen).toEqual([]);
    child().child.stdout.emit("data", Buffer.from("tial\r\n"));
    expect(seen).toEqual(["partial"]);
  });

  /*
   * stdout and stderr are independent pipes with no ordering guarantee between
   * them, and Java writes JVM, SLF4J and mod-stacktrace noise to stderr during
   * exactly the startup window the ready line lands in. With one shared
   * partial-line buffer, a stderr line arriving between two stdout chunks is
   * spliced into the middle of the half-written stdout line: the ready line
   * never matches, so state stays `starting` forever while the server is up
   * and playable, port/slots/gameVersion stay null, and (because `inspect`
   * gates `isStopped` on `running`) a later external shutdown is then
   * misreported as `crashed`.
   */
  it("keeps a split stdout line intact when a stderr line lands in the middle of it", () => {
    const seen: string[] = [];
    pm.on("line", (l) => seen.push(l.line));
    pm.start("Tulsa");

    const split = F.REAL_READY.indexOf("with 5 slots");
    child().child.stdout.emit("data", Buffer.from(F.REAL_READY.slice(0, split)));
    child().child.stderr.emit("data", Buffer.from("SLF4J: boom\n"));
    child().child.stdout.emit("data", Buffer.from(F.REAL_READY.slice(split) + "\r\n"));

    expect(seen).toContain("SLF4J: boom");
    expect(seen).toContain(
      '[2026-07-27 03:27:40] Started server using port 14159 with 5 slots on world "Tulsa.zip", game version 1.2.0.',
    );
    expect(pm.status.state).toBe("running");
    expect(pm.status.port).toBe(14159);
    expect(pm.status.slots).toBe(5);
    expect(pm.status.gameVersion).toBe("1.2.0");
    expect(pm.status.world).toBe("Tulsa");
  });

  it("buffers a partial stderr line without stdout completing it", () => {
    const seen: string[] = [];
    pm.on("line", (l) => seen.push(l.line));
    pm.start("Tulsa");

    child().child.stderr.emit("data", Buffer.from("Exception in thread "));
    child().child.stdout.emit("data", Buffer.from("normal stdout line\r\n"));
    expect(seen).toEqual(["normal stdout line"]);

    child().child.stderr.emit("data", Buffer.from('"main"\n'));
    expect(seen).toEqual(["normal stdout line", 'Exception in thread "main"']);
  });
});

describe("stop", () => {
  it("writes stop to stdin and resolves when the process exits", async () => {
    pm.start("Tulsa");
    child().child.emitLine(F.READY_LINE_WITH_TS);
    const done = pm.stop();
    expect(child().child.written).toEqual(["stop\n"]);
    expect(pm.status.state).toBe("stopping");
    child().child.exit(0);
    await done;
    expect(pm.status.state).toBe("stopped");
  });

  it("rejects on timeout without killing the process", async () => {
    pm.start("Tulsa");
    child().child.emitLine(F.READY_LINE_WITH_TS);
    await expect(pm.stop()).rejects.toThrow(/did not exit/i);
    expect(child().child.killed).toBe(false);
    expect(pm.status.state).toBe("stopping");
  });

  it("rejects when the server is not running", async () => {
    await expect(pm.stop()).rejects.toThrow(/not running/i);
  });

  it("still records an abnormal exit after the stop timeout already rejected", async () => {
    pm.start("Tulsa");
    child().child.emitLine(F.READY_LINE_WITH_TS);
    await expect(pm.stop()).rejects.toThrow(/did not exit/i);
    expect(pm.status.state).toBe("stopping");

    child().child.exit(1);

    expect(pm.status.state).toBe("crashed");
    expect(pm.status.lastError).toMatch(/code 1/);
  });

  it("still reports a clean stop for a zero exit after the stop timeout already rejected", async () => {
    pm.start("Tulsa");
    child().child.emitLine(F.READY_LINE_WITH_TS);
    await expect(pm.stop()).rejects.toThrow(/did not exit/i);
    expect(pm.status.state).toBe("stopping");

    child().child.exit(0);

    expect(pm.status.state).toBe("stopped");
    expect(pm.status.lastError).toBeNull();
  });

  /*
   * The wiring the 2026-07-27 ANSI defect actually broke, end to end, and the
   * only test here that covers it. Nobody calls pm.stop() in this scenario -
   * an in-game admin issued the stop - so the log line is the daemon's ONLY
   * signal that a shutdown is under way. Pre-fix, isStopped never matched the
   * real coloured line, so state stayed `running` through the exit, onExit saw
   * wasStopping === false, and a clean fully-saved shutdown was reported as
   * `crashed` with lastError "exited with code 0". Uses the captured line with
   * its escapes intact; asserting on a hand-cleaned line would not have caught
   * the bug.
   */
  it("reports an externally-initiated shutdown as stopped, not crashed", () => {
    pm.start("Tulsa");
    child().child.emitLine(F.REAL_READY);
    expect(pm.status.state).toBe("running");

    // The save line must NOT be mistaken for the shutdown line.
    child().child.emitLine(F.REAL_SAVE_COMPLETE);
    expect(pm.status.state).toBe("running");

    child().child.emitLine(F.REAL_STOPPED);
    expect(pm.status.state).toBe("stopping");

    child().child.exit(0);
    expect(pm.status.state).toBe("stopped");
    expect(pm.status.lastError).toBeNull();
  });

  it("treats a zero exit code during stop as clean, with no lastError", async () => {
    pm.start("Tulsa");
    child().child.emitLine(F.READY_LINE_WITH_TS);
    const done = pm.stop();
    child().child.exit(0);
    await done;
    expect(pm.status.state).toBe("stopped");
    expect(pm.status.lastError).toBeNull();
  });

  it("records lastError and rejects the pending stop() when the child exits nonzero mid-stop", async () => {
    pm.start("Tulsa");
    child().child.emitLine(F.READY_LINE_WITH_TS);
    const done = pm.stop();
    child().child.exit(1);
    await expect(done).rejects.toThrow(/stopping/i);
    expect(pm.status.state).toBe("crashed");
    expect(pm.status.lastError).toMatch(/code 1/);
  });
});

describe("crash detection", () => {
  it("marks crashed when the child exits during starting", () => {
    pm.start("Tulsa");
    child().child.emitLine("Some mod blew up");
    child().child.exit(1);
    expect(pm.status.state).toBe("crashed");
    expect(pm.status.lastError).toMatch(/exited with code 1/);
  });

  /*
   * The state stays `crashed` - the server went away without anyone asking it
   * to, and calling that `stopped` would present a failed launch as an idle
   * daemon - but the message is what the operator actually reads, and a code-0
   * exit is not a crash. Spec 4 defines crashed as a NONZERO exit, so the text
   * must not assert one.
   */
  it("does not describe a clean code-0 exit during starting as a crash", () => {
    pm.start("Tulsa");
    child().child.exit(0);
    expect(pm.status.state).toBe("crashed");
    expect(pm.status.lastError).toMatch(/code 0/);
    expect(pm.status.lastError).toMatch(/not a crash/i);
  });

  it("says a signal killed it when the exit carries no code", () => {
    pm.start("Tulsa");
    child().child.exit(null);
    expect(pm.status.lastError).toMatch(/terminated by a signal/i);
    expect(pm.status.lastError).not.toMatch(/code null/i);
  });

  it("marks crashed when a running server exits on its own", () => {
    pm.start("Tulsa");
    child().child.emitLine(F.READY_LINE_WITH_TS);
    child().child.exit(1);
    expect(pm.status.state).toBe("crashed");
  });

  it("clears lastError on the next start", () => {
    pm.start("Tulsa");
    child().child.exit(1);
    pm.start("Tulsa");
    expect(pm.status.lastError).toBeNull();
  });
});

describe("backlog", () => {
  it("caps the ring buffer at 2000 lines keeping the newest", () => {
    pm.start("Tulsa");
    for (let i = 0; i < 2100; i++) child().child.emitLine(`line ${i}`);
    expect(pm.backlog).toHaveLength(2000);
    expect(pm.backlog[pm.backlog.length - 1].line).toBe("line 2099");
    expect(pm.backlog[0].line).toBe("line 100");
  });
});

describe("kill", () => {
  it("kills the child and reports stopped after exit", () => {
    pm.start("Tulsa");
    pm.kill();
    expect(child().child.killed).toBe(true);
    child().child.exit(null);
    expect(pm.status.state).toBe("stopped");
  });
});

describe("kill on an unmanaged pid", () => {
  it("clears state when the pid is already gone (ESRCH is a success)", () => {
    // Alive on the liveness probe (signal 0) but ESRCH on the actual kill
    // attempt: models the pid exiting in the gap between the two, and keeps
    // this test about kill()'s own ESRCH handling rather than the lazy
    // liveness self-heal on markUnmanaged (covered separately below).
    const aliveThenGoneOnKill = (_pid: number, signal?: NodeJS.Signals | number): void => {
      if (signal === 0) return;
      const e = new Error("kill ESRCH") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    };
    const pm2 = new ProcessManager(cfg, spawn.spawn, aliveThenGoneOnKill);
    pm2.markUnmanaged(9001);
    pm2.kill();
    expect(pm2.status.state).toBe("stopped");
    expect(pm2.status.pid).toBeNull();
  });

  it("propagates a permission failure and does not clear state", () => {
    const pm2 = new ProcessManager(cfg, spawn.spawn, eperm);
    pm2.markUnmanaged(9001);
    expect(() => pm2.kill()).toThrow(/EPERM/i);
    expect(pm2.status.state).toBe("unmanaged");
    expect(pm2.status.pid).toBe(9001);
  });
});

describe("markUnmanaged", () => {
  // Reporting on pid 9001 through the real default killFn would make these
  // assertions depend on whether an unrelated real process 9001 happens to
  // exist on the machine running the tests, now that `.status` lazily
  // liveness-checks unmanaged pids (see "unmanaged liveness" below). Inject
  // `alive` so these stay about markUnmanaged/start/stop, not liveness.
  it("reports an externally started server with its pid", () => {
    const pm2 = new ProcessManager(cfg, spawn.spawn, alive);
    pm2.markUnmanaged(9001);
    expect(pm2.status.state).toBe("unmanaged");
    expect(pm2.status.pid).toBe(9001);
  });

  it("refuses to start while a server it does not own is running", () => {
    const pm2 = new ProcessManager(cfg, spawn.spawn, alive);
    pm2.markUnmanaged(9001);
    expect(() => pm2.start("Tulsa")).toThrow(/unmanaged/i);
  });

  it("cannot be stopped gracefully, and says why", async () => {
    const pm2 = new ProcessManager(cfg, spawn.spawn, alive);
    pm2.markUnmanaged(9001);
    await expect(pm2.stop()).rejects.toThrow(/was not started by this daemon/i);
  });

  it("returns to stopped when the external process is gone", () => {
    const pm2 = new ProcessManager(cfg, spawn.spawn, alive);
    pm2.markUnmanaged(9001);
    pm2.clearUnmanaged();
    expect(pm2.status.state).toBe("stopped");
    expect(pm2.status.pid).toBeNull();
  });
});

describe("refreshUnmanaged / status purity", () => {
  // `status` must be a pure read: no liveness check, no state mutation, no
  // emission. It's called from inside `setState`'s own emit, so a getter
  // that mutated state there would re-enter `setState` from within itself --
  // two emits for one transition, and the intermediate state never
  // delivered to any listener. The liveness check lives on the explicit
  // `refreshUnmanaged()` instead; callers that want the self-heal (like
  // GET /api/status in http.ts) call it before reading `.status`.

  it("markUnmanaged on a dead pid does not self-heal on its own", () => {
    const pm2 = new ProcessManager(cfg, spawn.spawn, esrch);
    const events: string[] = [];
    pm2.on("state", (s) => events.push(s.state));

    pm2.markUnmanaged(9001);

    expect(events).toEqual(["unmanaged"]);
    expect(pm2.status.state).toBe("unmanaged");
    expect(pm2.status.pid).toBe(9001);
  });

  it("reading .status repeatedly never mutates state or emits, even with a dead pid", () => {
    const pm2 = new ProcessManager(cfg, spawn.spawn, esrch);
    pm2.markUnmanaged(9001);

    const events: string[] = [];
    pm2.on("state", (s) => events.push(s.state));

    pm2.status;
    pm2.status;
    pm2.status;

    expect(pm2.status.state).toBe("unmanaged");
    expect(events).toEqual([]);
  });

  it("refreshUnmanaged() self-heals to stopped and emits exactly one state event when the pid is gone (ESRCH on signal 0)", () => {
    const pm2 = new ProcessManager(cfg, spawn.spawn, esrch);
    pm2.markUnmanaged(9001);

    const events: string[] = [];
    pm2.on("state", (s) => events.push(s.state));
    pm2.refreshUnmanaged();

    expect(events).toEqual(["stopped"]);
    expect(pm2.status.state).toBe("stopped");
    expect(pm2.status.pid).toBeNull();
  });

  it("refreshUnmanaged() stays unmanaged when the external process still exists (signal 0 succeeds)", () => {
    const pm2 = new ProcessManager(cfg, spawn.spawn, alive);
    pm2.markUnmanaged(9001);
    pm2.refreshUnmanaged();
    expect(pm2.status.state).toBe("unmanaged");
    expect(pm2.status.pid).toBe(9001);
  });

  it("refreshUnmanaged() does not falsely clear state on a permission error -- a process we can't signal still exists", () => {
    const pm2 = new ProcessManager(cfg, spawn.spawn, eperm);
    pm2.markUnmanaged(9001);
    pm2.refreshUnmanaged();
    expect(pm2.status.state).toBe("unmanaged");
    expect(pm2.status.pid).toBe(9001);
  });
});
