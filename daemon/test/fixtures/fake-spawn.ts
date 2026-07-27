import { EventEmitter } from "node:events";
import type { ChildLike, SpawnFn } from "../../src/process-manager.js";

export class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  killed = false;
  stdin = { write: (chunk: string) => void this.written.push(chunk) };

  kill(): void {
    this.killed = true;
  }

  /** Emit a line of server output as the real child would (with trailing newline). */
  emitLine(line: string): void {
    this.stdout.emit("data", Buffer.from(line + "\r\n"));
  }

  exit(code: number | null): void {
    this.emit("exit", code);
  }
}

export interface SpawnRecord {
  cmd: string;
  args: string[];
  cwd: string;
  child: FakeChild;
}

export function makeFakeSpawn(): { spawn: SpawnFn; calls: SpawnRecord[] } {
  const calls: SpawnRecord[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    const child = new FakeChild();
    calls.push({ cmd, args, cwd: opts.cwd, child });
    return child;
  };
  return { spawn, calls };
}
