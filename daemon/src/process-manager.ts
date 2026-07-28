import { EventEmitter } from "node:events";
import { parseReady, isStopped, stripAnsi } from "./log-lines.js";
import type { ConsoleLine, DaemonConfig, ServerState, ServerStatus } from "./types.js";

const BACKLOG_LIMIT = 2000;

export interface ChildLike {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write(chunk: string): void };
  on(ev: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(): void;
}

export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string }) => ChildLike;

/**
 * Sends a signal to an external pid. Defaults to `process.kill`; injectable so
 * tests never signal a real pid. The optional `signal` lets the same function
 * double as a liveness probe: `killFn(pid, 0)` tests existence without
 * affecting the process (see `isPidAlive`).
 */
export type KillFn = (pid: number, signal?: NodeJS.Signals | number) => void;

export class ProcessManager extends EventEmitter {
  private child: ChildLike | null = null;
  private state: ServerState = "stopped";
  private world: string | null = null;
  private startedAt: string | null = null;
  private port: number | null = null;
  private slots: number | null = null;
  private gameVersion: string | null = null;
  private lastError: string | null = null;
  private lines: ConsoleLine[] = [];
  /**
   * One partial-line buffer per stream. stdout and stderr are independent
   * pipes with no ordering guarantee between them, so a single shared buffer
   * splices a complete line from one stream into the middle of a half-written
   * line from the other. Java writes JVM, SLF4J and mod-stacktrace noise to
   * stderr during exactly the startup window the ready line lands in, so the
   * line that gets corrupted is routinely the ready line - and the daemon then
   * sits in `starting` forever while the server is up and playable.
   */
  private pending = { out: "", err: "" };
  private externalPid: number | null = null;
  private stopWaiter: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;

  constructor(
    private cfg: DaemonConfig,
    private spawnFn: SpawnFn,
    private killFn: KillFn = (pid, signal) => process.kill(pid, signal),
  ) {
    super();
  }

  // Deliberately NOT a StatusPayload: activeTasks is owned by the HTTP layer,
  // which composes the two into the payload clients actually see.
  get status(): ServerStatus {
    return {
      state: this.state,
      world: this.world,
      pid: this.child?.pid ?? this.externalPid,
      startedAt: this.startedAt,
      port: this.port,
      slots: this.slots,
      gameVersion: this.gameVersion,
      lastError: this.lastError,
    };
  }

  /**
   * An unmanaged server can be stopped by any means outside this daemon (its
   * own console, Task Manager, a reboot), and nothing else holds a handle on
   * it or watches for that. Callers that read status (e.g. GET /api/status)
   * must call this first so a stale `unmanaged` self-heals to `stopped` on
   * the next read, instead of getting stuck forever with no way for the
   * daemon to start a new server. Deliberately not run from inside the
   * `status` getter itself: `status` must stay a pure read with no side
   * effects, since `setState`'s emit already reads it and a mutating getter
   * would re-enter `setState` from within its own emit.
   */
  refreshUnmanaged(): void {
    if (this.state !== "unmanaged" || this.externalPid === null) return;
    if (!this.isPidAlive(this.externalPid)) this.clearUnmanaged();
  }

  /** Signal 0 tests existence without affecting the process; ESRCH means gone. Any other error (e.g. EPERM) means it is still alive, just not signallable by us. */
  private isPidAlive(pid: number): boolean {
    try {
      this.killFn(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  get backlog(): ConsoleLine[] {
    return [...this.lines];
  }

  /**
   * `-datadir` comes first among the game's own arguments, immediately after
   * `-nogui` and ahead of `-world`. Everything after it is interpreted relative
   * to it - the world named by `-world` is a save inside that directory, and the
   * mods the server loads come from its `mods` subfolder - so a reader (and any
   * left-to-right argument handling in the game) sees the directory established
   * before the things that live in it are named. It is also the argument that
   * makes this launch independent of which Windows account the daemon runs as,
   * which is worth having in the first position an operator reads in the log.
   */
  buildArgs(world: string): string[] {
    const owners = this.cfg.owners.flatMap((o) => ["-owner", o]);
    return [
      ...this.cfg.jvmArgs,
      "-jar",
      this.cfg.serverJar,
      "-nogui",
      "-datadir",
      this.cfg.dataDir,
      "-world",
      world,
      ...owners,
    ];
  }

  /** A Necesse server is running that this daemon did not spawn, so there is no stdin pipe to it. */
  markUnmanaged(pid: number): void {
    this.externalPid = pid;
    this.setState("unmanaged");
  }

  clearUnmanaged(): void {
    this.externalPid = null;
    this.setState("stopped");
  }

  /**
   * Why `start` would refuse right now, or null if it would go ahead.
   *
   * Split out of `start` so that work which must happen *before* the spawn -
   * reconciling the mods folder to the world's set, which deletes jars out of
   * it - can find out whether the spawn is going to be allowed at all before it
   * touches anything, and refuse in the same words. Two copies of this rule
   * would be two chances for the folder to be rewritten for a launch that was
   * never going to happen.
   */
  startRefusal(): string | null {
    if (this.state === "unmanaged") {
      return (
        `An unmanaged Necesse server (pid ${this.externalPid}) is already running. ` +
        `It was not started by this daemon and must be shut down before starting a new one.`
      );
    }
    if (this.state !== "stopped" && this.state !== "crashed") {
      return `Server is already ${this.state}; stop it before starting again.`;
    }
    return null;
  }

  start(world: string): void {
    const refusal = this.startRefusal();
    if (refusal !== null) throw new Error(refusal);
    this.world = world;
    this.port = null;
    this.slots = null;
    this.gameVersion = null;
    this.lastError = null;
    this.pending = { out: "", err: "" };
    this.startedAt = new Date().toISOString();

    const child = this.spawnFn(this.cfg.javaExe, this.buildArgs(world), { cwd: this.cfg.serverRoot });
    this.child = child;
    this.setState("starting");

    child.stdout.on("data", this.ingest("out"));
    child.stderr.on("data", this.ingest("err"));

    child.on("exit", (code) => this.onExit(code));
  }

  private ingest(stream: "out" | "err"): (buf: Buffer | string) => void {
    return (buf) => {
      this.pending[stream] += buf.toString();
      const parts = this.pending[stream].split("\n");
      this.pending[stream] = parts.pop() ?? "";
      for (const raw of parts) {
        // Colour escapes are stripped once, here, so both the recorded backlog
        // and the parsers see the same plain text. The client renders console
        // lines as text with no terminal emulator behind it, so an unstripped
        // line shows the operator a literal "[39m" before every message.
        const line = stripAnsi(raw.replace(/\r$/, ""));
        this.record(line);
        this.inspect(line);
      }
    };
  }

  private record(line: string): void {
    const entry: ConsoleLine = { line, ts: new Date().toISOString(), source: "server" };
    this.lines.push(entry);
    if (this.lines.length > BACKLOG_LIMIT) this.lines.splice(0, this.lines.length - BACKLOG_LIMIT);
    this.emit("line", entry);
  }

  private inspect(line: string): void {
    const ready = parseReady(line);
    if (ready && this.state === "starting") {
      this.port = ready.port;
      this.slots = ready.slots;
      this.gameVersion = ready.gameVersion;
      this.world = ready.world;
      this.setState("running");
      return;
    }
    if (isStopped(line) && this.state === "running") this.setState("stopping");
  }

  private onExit(code: number | null): void {
    // "stopping" covers both a graceful stop() awaiting exit and a kill() in
    // flight (kill() sets this state too but never a waiter), and it survives
    // the stop() timeout firing (the timeout nulls the waiter but leaves state
    // at "stopping"), so it — not waiter presence — is what tells an abnormal
    // exit during shutdown apart from a clean one. `code === null` (kill()'s
    // signature exit, notably on Windows) is never treated as abnormal.
    const wasStopping = this.state === "stopping";
    const abnormal = wasStopping && code !== 0 && code !== null;
    const waiter = this.stopWaiter;
    this.stopWaiter = null;
    this.child = null;

    if (abnormal) {
      this.lastError = `Server exited with code ${code} while stopping; the shutdown was not clean.`;
      this.setState("crashed");
    } else if (wasStopping) {
      this.setState("stopped");
    } else {
      // Still `crashed`: the server went away without anyone asking it to, and
      // presenting that as a normal `stopped` would make a failed launch look
      // like an idle daemon. But a code-0 exit is not a crash, and spec 4
      // defines crashed as a NONZERO exit, so the message must not claim one.
      // (`crashed` and `stopped` both permit a subsequent start(), so nothing
      // an operator can do is gated on the difference.)
      this.lastError =
        code === 0
          ? `Server process exited on its own with code 0 - a clean exit, not a crash - ` +
            `without the daemon asking it to stop. Check the console for why it gave up.`
          : code === null
            ? `Server process was terminated by a signal before it was asked to stop.`
            : `Server process exited with code ${code}`;
      this.setState("crashed");
    }

    // A waiter already settled by the timeout is gone (nulled there) by the
    // time we get here, so this never double-settles the same promise.
    if (waiter) {
      clearTimeout(waiter.timer);
      if (abnormal) {
        waiter.reject(new Error(this.lastError!));
      } else {
        waiter.resolve();
      }
    }
  }

  stop(): Promise<void> {
    if (this.state === "unmanaged") {
      return Promise.reject(
        new Error(
          `The running server (pid ${this.externalPid}) was not started by this daemon, ` +
            `so there is no stdin pipe to send stop to. It can only be force killed.`,
        ),
      );
    }
    if (!this.child || (this.state !== "running" && this.state !== "starting")) {
      return Promise.reject(new Error(`Server is not running (state: ${this.state}).`));
    }
    const child = this.child;
    this.setState("stopping");
    try {
      child.stdin.write("stop\n");
    } catch (e) {
      return Promise.reject(new Error(`Failed to write to server stdin: ${(e as Error).message}`));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stopWaiter = null;
        reject(
          new Error(
            `Server did not exit within ${this.cfg.stopTimeoutMs}ms of receiving stop. ` +
              `It may still be saving. The process was left running.`,
          ),
        );
      }, this.cfg.stopTimeoutMs);
      this.stopWaiter = { resolve, reject, timer };
    });
  }

  kill(): void {
    if (this.state === "unmanaged" && this.externalPid !== null) {
      // The UI offers this only for a server we did not spawn; it risks world loss.
      try {
        this.killFn(this.externalPid);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ESRCH") {
          // Not "already gone" (e.g. EPERM): a genuine failure, state must not clear.
          throw new Error(`Failed to kill unmanaged process (pid ${this.externalPid}): ${err.message}`);
        }
        // ESRCH: the pid is already gone, which is the goal state for this operation.
      }
      this.clearUnmanaged();
      return;
    }
    if (!this.child) throw new Error("No managed server process to kill.");
    this.setState("stopping");
    this.child.kill();
  }

  private setState(state: ServerState): void {
    this.state = state;
    if (state === "stopped" || state === "crashed") {
      this.pending = { out: "", err: "" };
      this.startedAt = null;
    }
    this.emit("state", this.status);
  }
}
