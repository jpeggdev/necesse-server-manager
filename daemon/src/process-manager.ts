import { EventEmitter } from "node:events";
import { parseReady, isStopped } from "./log-lines.js";
import type { ConsoleLine, DaemonConfig, ServerState, StatusPayload } from "./types.js";

const BACKLOG_LIMIT = 2000;

export interface ChildLike {
  pid?: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write(chunk: string): void };
  on(ev: "exit", cb: (code: number | null) => void): void;
  kill(): void;
}

export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string }) => ChildLike;

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
  private pending = "";
  private externalPid: number | null = null;
  private stopWaiter: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;

  constructor(private cfg: DaemonConfig, private spawnFn: SpawnFn) {
    super();
  }

  get status(): StatusPayload {
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

  get backlog(): ConsoleLine[] {
    return [...this.lines];
  }

  buildArgs(world: string): string[] {
    const owners = this.cfg.owners.flatMap((o) => ["-owner", o]);
    return [...this.cfg.jvmArgs, "-jar", this.cfg.serverJar, "-nogui", "-world", world, ...owners];
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

  start(world: string): void {
    if (this.state === "unmanaged") {
      throw new Error(
        `An unmanaged Necesse server (pid ${this.externalPid}) is already running. ` +
          `It was not started by this daemon and must be shut down before starting a new one.`,
      );
    }
    if (this.state !== "stopped" && this.state !== "crashed") {
      throw new Error(`Server is already ${this.state}; stop it before starting again.`);
    }
    this.world = world;
    this.port = null;
    this.slots = null;
    this.gameVersion = null;
    this.lastError = null;
    this.pending = "";
    this.startedAt = new Date().toISOString();

    const child = this.spawnFn(this.cfg.javaExe, this.buildArgs(world), { cwd: this.cfg.serverRoot });
    this.child = child;
    this.setState("starting");

    const onData = (buf: Buffer | string) => this.ingest(buf.toString());
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("exit", (code) => this.onExit(code));
  }

  private ingest(chunk: string): void {
    this.pending += chunk;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    for (const raw of parts) {
      const line = raw.replace(/\r$/, "");
      this.record(line);
      this.inspect(line);
    }
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
    const wasStopping = this.state === "stopping";
    this.child = null;
    if (wasStopping) {
      this.setState("stopped");
    } else {
      this.lastError = `Server process exited with code ${code}`;
      this.setState("crashed");
    }
    if (this.stopWaiter) {
      clearTimeout(this.stopWaiter.timer);
      this.stopWaiter.resolve();
      this.stopWaiter = null;
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
      process.kill(this.externalPid);
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
      this.pending = "";
      this.startedAt = null;
    }
    this.emit("state", this.status);
  }
}
