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

describe("buildArgs", () => {
  it("puts jvm args before -jar and one -owner per configured owner", () => {
    const args = pm.buildArgs("Infected Toenail");
    expect(args).toEqual([
      ...cfg.jvmArgs,
      "-jar",
      cfg.serverJar,
      "-nogui",
      "-world",
      "Infected Toenail",
      "-owner",
      "Jeff",
      "-owner",
      "Eli",
    ]);
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

  it("clears state when the pid is already gone (ESRCH is a success)", () => {
    const pm2 = new ProcessManager(cfg, spawn.spawn, esrch);
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
  it("reports an externally started server with its pid", () => {
    pm.markUnmanaged(9001);
    expect(pm.status.state).toBe("unmanaged");
    expect(pm.status.pid).toBe(9001);
  });

  it("refuses to start while a server it does not own is running", () => {
    pm.markUnmanaged(9001);
    expect(() => pm.start("Tulsa")).toThrow(/unmanaged/i);
  });

  it("cannot be stopped gracefully, and says why", async () => {
    pm.markUnmanaged(9001);
    await expect(pm.stop()).rejects.toThrow(/was not started by this daemon/i);
  });

  it("returns to stopped when the external process is gone", () => {
    pm.markUnmanaged(9001);
    pm.clearUnmanaged();
    expect(pm.status.state).toBe("stopped");
    expect(pm.status.pid).toBeNull();
  });
});
