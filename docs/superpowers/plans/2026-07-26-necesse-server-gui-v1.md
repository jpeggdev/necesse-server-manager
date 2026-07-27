# Necesse Server GUI v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Tauri desktop app on the workstation that starts/stops a Necesse dedicated server on a separate LAN machine, manages its Steam Workshop mods by id, updates the server binaries, and streams its console live.

**Architecture:** A Node/TypeScript daemon runs on `SERVER` (192.168.1.106) and owns all state and side effects — it spawns the Necesse server as a child process and holds its stdin pipe, which is the only way a graceful `stop` is possible on Windows. A Tauri 2 + React client on the workstation is a thin view over the daemon's HTTP + WebSocket API and holds no authoritative state.

**Tech Stack:** Node 22 LTS, TypeScript (strict), Fastify + `@fastify/websocket` + `@fastify/cors`, Vitest, Tauri 2, React 18, Vite.

**Spec:** `docs/superpowers/specs/2026-07-26-necesse-server-gui-design.html`

## Global Constraints

- **Node 22 LTS** on both machines. TypeScript `strict: true`. ES modules (`"type": "module"`).
- **No authentication.** Trusted LAN, deliberate. Daemon binds `0.0.0.0:8710`.
- **Every filesystem path comes from `config.json`.** Never hardcode a path in `src/` — the paths below are *defaults written into config at deploy time*, not constants in code.
- **Verified paths on SERVER** (read over SSH 2026-07-26, do not assume alternatives):
  - Server root: `C:\necesseserver`
  - Java: `C:\necesseserver\jre\bin\java.exe`
  - Server jar: `C:\necesseserver\Server.jar`
  - steamcmd: `C:\Users\jeffp\steam\steamcmd.exe`
  - Mods: `C:\Users\jeffp\AppData\Roaming\Necesse\mods`
  - Worlds: `C:\Users\jeffp\AppData\Roaming\Necesse\saves\worlds`
- **Steam app ids:** dedicated server `1169370` (anonymous), workshop `1169040` (anonymous).
- **Launch args:** `-nogui -world "<name>" -owner <each owner>`. Working directory MUST be the server root.
- **Mod mutations and server updates are refused while the server is running.** Return an error; never stop the server as a side effect.
- **Hard kill is never automatic.** It is a separate endpoint, never an escalation from a stop timeout.
- **Errors are never reworded or swallowed.** Propagate the underlying tool's own output.
- **Log line parsing must tolerate an optional leading `[YYYY-MM-DD HH:MM:SS] ` timestamp.** The log *file* carries timestamps; whether stdout does is unverified until Task 12. Strip it if present, never anchor a pattern to the raw start of line.

**SSH to SERVER** (already configured, key has no passphrase):
```powershell
ssh -i "$env:USERPROFILE\.ssh\necesse_server" jeffp@192.168.1.106 "<cmd>"
scp -i "$env:USERPROFILE\.ssh\necesse_server" <local> jeffp@192.168.1.106:C:/Users/jeffp/<remote>
```
The remote default shell is **cmd.exe**. For PowerShell, copy a `.ps1` and run `powershell -NoProfile -ExecutionPolicy Bypass -File <path>`. Do not fight nested quoting.

## File Structure

```
daemon/
  package.json  tsconfig.json  vitest.config.ts
  src/
    types.ts            Shared types. No logic, no imports from other src modules.
    config.ts           Load/save config.json. Single source of truth for paths.
    log-lines.ts        Pure parsers for Necesse server output.
    process-manager.ts  Owns the child process, stdin pipe, state machine, ring buffer.
    worlds.ts           Enumerate world zips; existence checks.
    mod-registry.ts     Read/write mods.json (workshop id -> jar).
    steamcmd.ts         Run steamcmd, stream output. No registry knowledge.
    mod-installer.ts    download -> copy -> delete stale jar -> update registry.
    http.ts             Fastify routes + WebSocket fan-out. Thin.
    index.ts            Entrypoint: load config, wire modules, listen.
  test/
    fixtures/log-fixtures.ts   Real captured server output lines.
    fixtures/fake-spawn.ts     Controllable SpawnFn test double.
    *.test.ts
client/                 Tauri 2 + React scaffold (Task 9)
scripts/
  01-install-node.ps1   Run ON SERVER: install Node LTS.
  02-deploy.ps1         Run on workstation: build + scp daemon to SERVER.
  03-register-task.ps1  Run ON SERVER: firewall rule + Scheduled Task.
  seed/config.json      Deployed config with verified paths.
  seed/mods.json        Pre-seeded registry (8 mods).
```

---

### Task 1: Daemon scaffold, shared types, and config module

**Files:**
- Create: `daemon/package.json`, `daemon/tsconfig.json`, `daemon/vitest.config.ts`
- Create: `daemon/src/types.ts`, `daemon/src/config.ts`
- Test: `daemon/test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type in `types.ts` (used by all later tasks); `loadConfig(file: string): Promise<DaemonConfig>`, `saveConfig(file: string, cfg: DaemonConfig): Promise<void>`, `DEFAULT_CONFIG: DaemonConfig`.

- [ ] **Step 1: Create the daemon package**

`daemon/package.json`:
```json
{
  "name": "necesse-daemon",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "fastify": "^5.2.0",
    "@fastify/cors": "^10.0.1",
    "@fastify/websocket": "^11.0.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`daemon/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

`daemon/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
```

Run: `cd daemon; npm install`

- [ ] **Step 2: Write `src/types.ts`**

```ts
export type ServerState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "unmanaged"
  | "crashed";

export interface StatusPayload {
  state: ServerState;
  world: string | null;
  pid: number | null;
  startedAt: string | null;
  port: number | null;
  slots: number | null;
  gameVersion: string | null;
  /** Set when the server exits abnormally; cleared on the next successful start. */
  lastError: string | null;
}

export interface DaemonConfig {
  port: number;
  serverRoot: string;
  javaExe: string;
  serverJar: string;
  steamcmdExe: string;
  modsDir: string;
  worldsDir: string;
  jvmArgs: string[];
  owners: string[];
  lastWorld: string | null;
  serverAppId: number;
  workshopAppId: number;
  stopTimeoutMs: number;
}

export interface ModEntry {
  id: string;
  name: string;
  jar: string;
  lastUpdated: string;
}

export interface UntrackedMod {
  jar: string;
}

export interface ModListResponse {
  managed: ModEntry[];
  untracked: UntrackedMod[];
}

export interface WorldInfo {
  name: string;
  modifiedAt: string;
  sizeBytes: number;
}

export interface ConsoleLine {
  line: string;
  ts: string;
  source: "server" | "task";
}

export type TaskKind = "mod-install" | "mod-remove" | "mod-update-all" | "server-update";

export interface InstallResult {
  id: string;
  name: string;
  jar: string | null;
  ok: boolean;
  error?: string;
  replacedJar?: string;
}

export type WsMessage =
  | { type: "backlog"; lines: ConsoleLine[]; status: StatusPayload }
  | { type: "console"; line: string; ts: string }
  | { type: "status"; status: StatusPayload }
  | { type: "task"; taskId: string; kind: TaskKind; line: string }
  | {
      type: "task-done";
      taskId: string;
      kind: TaskKind;
      ok: boolean;
      error?: string;
      results?: InstallResult[];
    };

export interface ApiError {
  ok: false;
  error: string;
}
```

- [ ] **Step 3: Write the failing test**

`daemon/test/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "../src/config.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "necesse-cfg-"));
}

describe("config", () => {
  it("returns defaults and writes the file when it does not exist", async () => {
    const file = join(await tmp(), "config.json");
    const cfg = await loadConfig(file);
    expect(cfg.port).toBe(8710);
    expect(cfg.serverAppId).toBe(1169370);
    expect(cfg.workshopAppId).toBe(1169040);
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written.port).toBe(8710);
  });

  it("merges a partial file over defaults so new keys gain defaults", async () => {
    const file = join(await tmp(), "config.json");
    await writeFile(file, JSON.stringify({ owners: ["Jeff", "Eli"], port: 9000 }));
    const cfg = await loadConfig(file);
    expect(cfg.owners).toEqual(["Jeff", "Eli"]);
    expect(cfg.port).toBe(9000);
    expect(cfg.stopTimeoutMs).toBe(DEFAULT_CONFIG.stopTimeoutMs);
  });

  it("round-trips through save", async () => {
    const file = join(await tmp(), "config.json");
    const cfg = { ...DEFAULT_CONFIG, lastWorld: "Infected Toenail" };
    await saveConfig(file, cfg);
    expect((await loadConfig(file)).lastWorld).toBe("Infected Toenail");
  });

  it("throws with the file path in the message on malformed JSON", async () => {
    const file = join(await tmp(), "config.json");
    await writeFile(file, "{ not json");
    await expect(loadConfig(file)).rejects.toThrow(file);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd daemon; npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 5: Implement `src/config.ts`**

```ts
import { readFile, writeFile } from "node:fs/promises";
import type { DaemonConfig } from "./types.js";

export const DEFAULT_CONFIG: DaemonConfig = {
  port: 8710,
  serverRoot: "C:\\necesseserver",
  javaExe: "C:\\necesseserver\\jre\\bin\\java.exe",
  serverJar: "C:\\necesseserver\\Server.jar",
  steamcmdExe: "C:\\Users\\jeffp\\steam\\steamcmd.exe",
  modsDir: "C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\mods",
  worldsDir: "C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\saves\\worlds",
  jvmArgs: [
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+UseG1GC",
    "-XX:+ExplicitGCInvokesConcurrent",
    "-XX:G1NewSizePercent=20",
    "-XX:G1ReservePercent=20",
    "-XX:MaxGCPauseMillis=50",
    "-XX:G1HeapRegionSize=32M",
  ],
  owners: [],
  lastWorld: null,
  serverAppId: 1169370,
  workshopAppId: 1169040,
  stopTimeoutMs: 90_000,
};

export async function loadConfig(file: string): Promise<DaemonConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    const cfg = { ...DEFAULT_CONFIG };
    await saveConfig(file, cfg);
    return cfg;
  }
  let parsed: Partial<DaemonConfig>;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse config at ${file}: ${(e as Error).message}`);
  }
  return { ...DEFAULT_CONFIG, ...parsed };
}

export async function saveConfig(file: string, cfg: DaemonConfig): Promise<void> {
  await writeFile(file, JSON.stringify(cfg, null, 2), "utf8");
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd daemon; npx vitest run test/config.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add daemon/package.json daemon/tsconfig.json daemon/vitest.config.ts daemon/src/types.ts daemon/src/config.ts daemon/test/config.test.ts daemon/package-lock.json
git commit -m "feat(daemon): scaffold package, shared types, and config module"
```

---

### Task 2: Log line parsers

Isolated as its own task because the entire state machine keys off these patterns, and they are the part most likely to need adjustment after live verification.

**Files:**
- Create: `daemon/src/log-lines.ts`, `daemon/test/fixtures/log-fixtures.ts`
- Test: `daemon/test/log-lines.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `stripTimestamp(line: string): string`, `parseReady(line: string): ReadyInfo | null`, `isStopped(line: string): boolean`, `isLoadingExistingWorld(line: string): boolean`, and `interface ReadyInfo { port: number; slots: number; world: string; gameVersion: string }`.

- [ ] **Step 1: Capture real fixtures**

`daemon/test/fixtures/log-fixtures.ts` — verbatim lines from SERVER's `latest-server-log.txt`:
```ts
export const READY_LINE_WITH_TS =
  '[2026-07-26 22:40:55] Started server using port 14159 with 5 slots on world "Infected Toenail.zip", game version 1.2.0.';

export const READY_LINE_NO_TS =
  'Started server using port 14159 with 5 slots on world "Infected Toenail.zip", game version 1.2.0.';

export const LOADING_EXISTING =
  "[2026-07-26 22:40:55] Loading existing world at C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\saves\\worlds\\Infected Toenail.zip";

export const STOP_ECHO = "[2026-07-26 23:18:22] > stop";
export const SAVE_COMPLETE = "[2026-07-26 23:18:22] Completed world save before stopping server";
export const STOPPED_LINE = "[2026-07-26 23:18:22] Server has stopped";
export const MOD_FOUND =
  "[2026-07-26 22:40:42] Found mod: Safe Haven QOL (torvian.qol, 2.6) from ModsFolderModProvider";
export const INVALID_JAR_WARN =
  "[2026-07-26 22:40:42] (WARN) Invalid mod jar located at C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\mods\\torvians-qol.cfg";
```

- [ ] **Step 2: Write the failing test**

`daemon/test/log-lines.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { stripTimestamp, parseReady, isStopped, isLoadingExistingWorld } from "../src/log-lines.js";
import * as F from "./fixtures/log-fixtures.js";

describe("stripTimestamp", () => {
  it("removes a leading bracketed timestamp", () => {
    expect(stripTimestamp(F.STOPPED_LINE)).toBe("Server has stopped");
  });
  it("leaves an untimestamped line alone", () => {
    expect(stripTimestamp(F.READY_LINE_NO_TS)).toBe(F.READY_LINE_NO_TS);
  });
});

describe("parseReady", () => {
  it("parses the ready line with a timestamp", () => {
    expect(parseReady(F.READY_LINE_WITH_TS)).toEqual({
      port: 14159,
      slots: 5,
      world: "Infected Toenail",
      gameVersion: "1.2.0",
    });
  });

  it("parses the ready line without a timestamp", () => {
    expect(parseReady(F.READY_LINE_NO_TS)?.world).toBe("Infected Toenail");
  });

  it("strips only a trailing .zip, preserving names containing dots", () => {
    const line = 'Started server using port 1 with 2 slots on world "v1.2 test.zip", game version 1.2.0.';
    expect(parseReady(line)?.world).toBe("v1.2 test");
  });

  it("returns null for unrelated lines", () => {
    expect(parseReady(F.MOD_FOUND)).toBeNull();
    expect(parseReady(F.INVALID_JAR_WARN)).toBeNull();
  });
});

describe("isStopped", () => {
  it("matches the shutdown line", () => {
    expect(isStopped(F.STOPPED_LINE)).toBe(true);
  });
  it("does not match the save line or the stop echo", () => {
    expect(isStopped(F.SAVE_COMPLETE)).toBe(false);
    expect(isStopped(F.STOP_ECHO)).toBe(false);
  });
});

describe("isLoadingExistingWorld", () => {
  it("detects an existing world load", () => {
    expect(isLoadingExistingWorld(F.LOADING_EXISTING)).toBe(true);
    expect(isLoadingExistingWorld(F.READY_LINE_NO_TS)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd daemon; npx vitest run test/log-lines.test.ts`
Expected: FAIL — cannot resolve `../src/log-lines.js`.

- [ ] **Step 4: Implement `src/log-lines.ts`**

```ts
export interface ReadyInfo {
  port: number;
  slots: number;
  world: string;
  gameVersion: string;
}

const TIMESTAMP = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/;

const READY =
  /Started server using port (\d+) with (\d+) slots on world "(.+?)", game version ([\d.]+)/;

/**
 * The log file prefixes every line with a timestamp; whether stdout does is
 * unverified. Every parser tolerates both forms rather than assuming one.
 */
export function stripTimestamp(line: string): string {
  return line.replace(TIMESTAMP, "");
}

export function parseReady(line: string): ReadyInfo | null {
  const m = READY.exec(stripTimestamp(line));
  if (!m) return null;
  const world = m[3].endsWith(".zip") ? m[3].slice(0, -".zip".length) : m[3];
  return {
    port: Number(m[1]),
    slots: Number(m[2]),
    world,
    gameVersion: m[4],
  };
}

export function isStopped(line: string): boolean {
  return stripTimestamp(line) === "Server has stopped";
}

export function isLoadingExistingWorld(line: string): boolean {
  return stripTimestamp(line).startsWith("Loading existing world at ");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd daemon; npx vitest run test/log-lines.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add daemon/src/log-lines.ts daemon/test/log-lines.test.ts daemon/test/fixtures/log-fixtures.ts
git commit -m "feat(daemon): parse Necesse server log lines from real captured output"
```

---

### Task 3: Process manager

**Files:**
- Create: `daemon/src/process-manager.ts`, `daemon/test/fixtures/fake-spawn.ts`
- Test: `daemon/test/process-manager.test.ts`

**Interfaces:**
- Consumes: `DaemonConfig`, `StatusPayload`, `ConsoleLine`, `ServerState` from `types.js`; `parseReady`, `isStopped` from `log-lines.js`.
- Produces:
  - `type SpawnFn = (cmd: string, args: string[], opts: { cwd: string }) => ChildLike`
  - `interface ChildLike { pid?: number; stdout: EventEmitter; stderr: EventEmitter; stdin: { write(chunk: string): void }; on(ev: "exit", cb: (code: number | null) => void): void; kill(): void }`
  - `class ProcessManager` with `status: StatusPayload` (getter), `backlog: ConsoleLine[]` (getter), `buildArgs(world: string): string[]`, `start(world: string): void`, `stop(): Promise<void>`, `kill(): void`, and events `line` (`ConsoleLine`) and `state` (`StatusPayload`).

- [ ] **Step 1: Write the fake spawn double**

`daemon/test/fixtures/fake-spawn.ts`:
```ts
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
```

- [ ] **Step 2: Write the failing test**

`daemon/test/process-manager.test.ts`:
```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd daemon; npx vitest run test/process-manager.test.ts`
Expected: FAIL — cannot resolve `../src/process-manager.js`.

- [ ] **Step 4: Implement `src/process-manager.ts`**

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd daemon; npx vitest run test/process-manager.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 6: Commit**

```bash
git add daemon/src/process-manager.ts daemon/test/process-manager.test.ts daemon/test/fixtures/fake-spawn.ts
git commit -m "feat(daemon): process manager owning the server child process and stdin stop"
```

---

### Task 4: Worlds module

**Files:**
- Create: `daemon/src/worlds.ts`
- Test: `daemon/test/worlds.test.ts`

**Interfaces:**
- Consumes: `WorldInfo` from `types.js`.
- Produces: `listWorlds(worldsDir: string): Promise<WorldInfo[]>`, `worldExists(worldsDir: string, name: string): Promise<boolean>`, `isValidWorldName(name: string): boolean`.

- [ ] **Step 1: Write the failing test**

`daemon/test/worlds.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorlds, worldExists, isValidWorldName } from "../src/worlds.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necesse-worlds-"));
  await writeFile(join(dir, "Tulsa.zip"), "a");
  await writeFile(join(dir, "Infected Toenail.zip"), "bb");
  await writeFile(join(dir, "LATEST_BACKUP1.zip"), "ccc");
  await writeFile(join(dir, "notes.txt"), "d");
  await mkdir(join(dir, "somedir.zip"));
});

describe("listWorlds", () => {
  it("lists zip files without the extension", async () => {
    const names = (await listWorlds(dir)).map((w) => w.name);
    expect(names).toContain("Tulsa");
    expect(names).toContain("Infected Toenail");
  });

  it("excludes non-zip files and directories", async () => {
    const names = (await listWorlds(dir)).map((w) => w.name);
    expect(names).not.toContain("notes");
    expect(names).not.toContain("somedir");
  });

  it("excludes automatic backups, which are not selectable worlds", async () => {
    const names = (await listWorlds(dir)).map((w) => w.name);
    expect(names).not.toContain("LATEST_BACKUP1");
  });

  it("reports size and modified time", async () => {
    const tulsa = (await listWorlds(dir)).find((w) => w.name === "Tulsa");
    expect(tulsa?.sizeBytes).toBe(1);
    expect(Date.parse(tulsa!.modifiedAt)).not.toBeNaN();
  });

  it("returns an empty list when the directory is missing", async () => {
    expect(await listWorlds(join(dir, "nope"))).toEqual([]);
  });
});

describe("worldExists", () => {
  it("is true for an existing world and false otherwise", async () => {
    expect(await worldExists(dir, "Tulsa")).toBe(true);
    expect(await worldExists(dir, "Brand New")).toBe(false);
  });

  it("is case-insensitive, matching Windows filesystem behaviour", async () => {
    expect(await worldExists(dir, "tULSA")).toBe(true);
  });
});

describe("isValidWorldName", () => {
  it("rejects empty, path separators, and characters Windows forbids", () => {
    expect(isValidWorldName("Good Name")).toBe(true);
    expect(isValidWorldName("")).toBe(false);
    expect(isValidWorldName("   ")).toBe(false);
    expect(isValidWorldName("a/b")).toBe(false);
    expect(isValidWorldName("a\\b")).toBe(false);
    expect(isValidWorldName("a:b")).toBe(false);
    expect(isValidWorldName("a?b")).toBe(false);
    expect(isValidWorldName("..")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon; npx vitest run test/worlds.test.ts`
Expected: FAIL — cannot resolve `../src/worlds.js`.

- [ ] **Step 3: Implement `src/worlds.ts`**

```ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorldInfo } from "./types.js";

/** The server writes these rolling autosaves itself; they are not selectable worlds. */
const BACKUP = /^LATEST_BACKUP\d+$/i;
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/;

export async function listWorlds(worldsDir: string): Promise<WorldInfo[]> {
  let entries;
  try {
    entries = await readdir(worldsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorldInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".zip")) continue;
    const name = e.name.slice(0, -".zip".length);
    if (BACKUP.test(name)) continue;
    const s = await stat(join(worldsDir, e.name));
    out.push({ name, modifiedAt: s.mtime.toISOString(), sizeBytes: s.size });
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function worldExists(worldsDir: string, name: string): Promise<boolean> {
  const target = name.toLowerCase();
  return (await listWorlds(worldsDir)).some((w) => w.name.toLowerCase() === target);
}

export function isValidWorldName(name: string): boolean {
  if (name.trim().length === 0) return false;
  if (name === "." || name === "..") return false;
  return !ILLEGAL.test(name);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd daemon; npx vitest run test/worlds.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add daemon/src/worlds.ts daemon/test/worlds.test.ts
git commit -m "feat(daemon): enumerate world saves and validate world names"
```

---

### Task 5: Mod registry

**Files:**
- Create: `daemon/src/mod-registry.ts`
- Test: `daemon/test/mod-registry.test.ts`

**Interfaces:**
- Consumes: `ModEntry` from `types.js`.
- Produces: `class ModRegistry` with `constructor(file: string)`, `load(): Promise<ModEntry[]>`, `get(id: string): Promise<ModEntry | undefined>`, `upsert(entry: ModEntry): Promise<void>`, `remove(id: string): Promise<ModEntry | undefined>`.

- [ ] **Step 1: Write the failing test**

`daemon/test/mod-registry.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModRegistry } from "../src/mod-registry.js";

let file: string;
let reg: ModRegistry;

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), "necesse-mods-")), "mods.json");
  reg = new ModRegistry(file);
});

const entry = {
  id: "3731244177",
  name: "Safe Haven QOL",
  jar: "SafeHavenQOL-1.2.0-2.6.jar",
  lastUpdated: "2026-07-26T04:24:00.000Z",
};

describe("ModRegistry", () => {
  it("returns an empty list when the file does not exist", async () => {
    expect(await reg.load()).toEqual([]);
  });

  it("persists an entry across instances", async () => {
    await reg.upsert(entry);
    expect(await new ModRegistry(file).get("3731244177")).toEqual(entry);
  });

  it("replaces rather than duplicates on repeat upsert", async () => {
    await reg.upsert(entry);
    await reg.upsert({ ...entry, jar: "SafeHavenQOL-1.2.0-2.7.jar" });
    const all = await reg.load();
    expect(all).toHaveLength(1);
    expect(all[0].jar).toBe("SafeHavenQOL-1.2.0-2.7.jar");
  });

  it("returns the removed entry, and undefined for an unknown id", async () => {
    await reg.upsert(entry);
    expect((await reg.remove("3731244177"))?.jar).toBe(entry.jar);
    expect(await reg.load()).toEqual([]);
    expect(await reg.remove("3731244177")).toBeUndefined();
  });

  it("throws with the file path on malformed JSON rather than silently resetting", async () => {
    await writeFile(file, "{{{");
    await expect(reg.load()).rejects.toThrow(file);
  });

  it("writes readable JSON", async () => {
    await reg.upsert(entry);
    expect(await readFile(file, "utf8")).toContain("\n  ");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon; npx vitest run test/mod-registry.test.ts`
Expected: FAIL — cannot resolve `../src/mod-registry.js`.

- [ ] **Step 3: Implement `src/mod-registry.ts`**

```ts
import { readFile, writeFile } from "node:fs/promises";
import type { ModEntry } from "./types.js";

export class ModRegistry {
  constructor(private file: string) {}

  async load(): Promise<ModEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    try {
      return JSON.parse(raw) as ModEntry[];
    } catch (e) {
      throw new Error(`Failed to parse mod registry at ${this.file}: ${(e as Error).message}`);
    }
  }

  async get(id: string): Promise<ModEntry | undefined> {
    return (await this.load()).find((m) => m.id === id);
  }

  async upsert(entry: ModEntry): Promise<void> {
    const all = (await this.load()).filter((m) => m.id !== entry.id);
    all.push(entry);
    await this.write(all);
  }

  async remove(id: string): Promise<ModEntry | undefined> {
    const all = await this.load();
    const found = all.find((m) => m.id === id);
    if (!found) return undefined;
    await this.write(all.filter((m) => m.id !== id));
    return found;
  }

  private async write(entries: ModEntry[]): Promise<void> {
    await writeFile(this.file, JSON.stringify(entries, null, 2), "utf8");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd daemon; npx vitest run test/mod-registry.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add daemon/src/mod-registry.ts daemon/test/mod-registry.test.ts
git commit -m "feat(daemon): mod registry mapping workshop ids to installed jars"
```

---

### Task 6: steamcmd runner

**Files:**
- Create: `daemon/src/steamcmd.ts`
- Test: `daemon/test/steamcmd.test.ts`

**Interfaces:**
- Consumes: `DaemonConfig` from `types.js`; `SpawnFn`, `ChildLike` from `process-manager.js`.
- Produces: `interface SteamCmdResult { ok: boolean; exitCode: number | null; output: string }`, `class SteamCmd` with `constructor(cfg: DaemonConfig, spawnFn: SpawnFn)`, `workshopItemDir(id: string): string`, `buildWorkshopArgs(id: string): string[]`, `buildUpdateArgs(): string[]`, `downloadWorkshopItem(id, onLine): Promise<SteamCmdResult>`, `updateApp(onLine): Promise<SteamCmdResult>`.

- [ ] **Step 1: Write the failing test**

`daemon/test/steamcmd.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { SteamCmd } from "../src/steamcmd.js";
import { makeFakeSpawn } from "./fixtures/fake-spawn.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { join } from "node:path";

const cfg = { ...DEFAULT_CONFIG, steamcmdExe: "C:\\Users\\jeffp\\steam\\steamcmd.exe" };

let spawn: ReturnType<typeof makeFakeSpawn>;
let steam: SteamCmd;

beforeEach(() => {
  spawn = makeFakeSpawn();
  steam = new SteamCmd(cfg, spawn.spawn);
});

describe("argument construction", () => {
  it("downloads a workshop item anonymously for the workshop app id", () => {
    expect(steam.buildWorkshopArgs("3731244177")).toEqual([
      "+login",
      "anonymous",
      "+workshop_download_item",
      "1169040",
      "3731244177",
      "+quit",
    ]);
  });

  it("puts force_install_dir before login when updating the server app", () => {
    const args = steam.buildUpdateArgs();
    expect(args.indexOf("+force_install_dir")).toBeLessThan(args.indexOf("+login"));
    expect(args).toEqual([
      "+force_install_dir",
      cfg.serverRoot,
      "+login",
      "anonymous",
      "+app_update",
      "1169370",
      "validate",
      "+quit",
    ]);
  });

  it("resolves the workshop content dir next to the steamcmd executable", () => {
    expect(steam.workshopItemDir("3731244177")).toBe(
      join("C:\\Users\\jeffp\\steam", "steamapps", "workshop", "content", "1169040", "3731244177"),
    );
  });
});

describe("downloadWorkshopItem", () => {
  it("streams every output line and reports success on exit 0", async () => {
    const seen: string[] = [];
    const p = steam.downloadWorkshopItem("123", (l) => seen.push(l));
    const c = spawn.calls[0].child;
    c.emitLine("Redirecting stderr");
    c.emitLine('Success. Downloaded item 123 to "C:\\..."');
    c.exit(0);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(seen).toContain("Redirecting stderr");
    expect(r.output).toContain("Success. Downloaded item 123");
  });

  it("reports failure with steamcmd's own output on a nonzero exit", async () => {
    const p = steam.downloadWorkshopItem("123", () => {});
    const c = spawn.calls[0].child;
    c.emitLine("ERROR! Download item 123 failed (Failure).");
    c.exit(8);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(8);
    expect(r.output).toContain("ERROR! Download item 123 failed");
  });

  it("rejects with the spawn error when steamcmd is missing", async () => {
    const failing = () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    const s = new SteamCmd(cfg, failing as never);
    await expect(s.downloadWorkshopItem("1", () => {})).rejects.toThrow(
      /steamcmd.exe.*ENOENT/s,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon; npx vitest run test/steamcmd.test.ts`
Expected: FAIL — cannot resolve `../src/steamcmd.js`.

- [ ] **Step 3: Implement `src/steamcmd.ts`**

```ts
import { dirname, join } from "node:path";
import type { ChildLike, SpawnFn } from "./process-manager.js";
import type { DaemonConfig } from "./types.js";

export interface SteamCmdResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export class SteamCmd {
  constructor(private cfg: DaemonConfig, private spawnFn: SpawnFn) {}

  private get steamRoot(): string {
    return dirname(this.cfg.steamcmdExe);
  }

  workshopItemDir(id: string): string {
    return join(this.steamRoot, "steamapps", "workshop", "content", String(this.cfg.workshopAppId), id);
  }

  buildWorkshopArgs(id: string): string[] {
    return [
      "+login",
      "anonymous",
      "+workshop_download_item",
      String(this.cfg.workshopAppId),
      id,
      "+quit",
    ];
  }

  buildUpdateArgs(): string[] {
    // force_install_dir must precede login or steamcmd installs to its own root.
    return [
      "+force_install_dir",
      this.cfg.serverRoot,
      "+login",
      "anonymous",
      "+app_update",
      String(this.cfg.serverAppId),
      "validate",
      "+quit",
    ];
  }

  downloadWorkshopItem(id: string, onLine: (line: string) => void): Promise<SteamCmdResult> {
    return this.run(this.buildWorkshopArgs(id), onLine);
  }

  updateApp(onLine: (line: string) => void): Promise<SteamCmdResult> {
    return this.run(this.buildUpdateArgs(), onLine);
  }

  private run(args: string[], onLine: (line: string) => void): Promise<SteamCmdResult> {
    let child: ChildLike;
    try {
      child = this.spawnFn(this.cfg.steamcmdExe, args, { cwd: this.steamRoot });
    } catch (e) {
      return Promise.reject(
        new Error(`Failed to run ${this.cfg.steamcmdExe}: ${(e as Error).message}`),
      );
    }
    return new Promise<SteamCmdResult>((resolve) => {
      const collected: string[] = [];
      let pending = "";
      const ingest = (buf: Buffer | string) => {
        pending += buf.toString();
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.replace(/\r$/, "");
          collected.push(line);
          onLine(line);
        }
      };
      child.stdout.on("data", ingest);
      child.stderr.on("data", ingest);
      child.on("exit", (code) => {
        if (pending.length > 0) {
          collected.push(pending);
          onLine(pending);
        }
        resolve({ ok: code === 0, exitCode: code, output: collected.join("\n") });
      });
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd daemon; npx vitest run test/steamcmd.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add daemon/src/steamcmd.ts daemon/test/steamcmd.test.ts
git commit -m "feat(daemon): steamcmd runner for workshop downloads and app updates"
```

---

### Task 7: Mod installer

This is where the stale-jar bug from `Update-Necesse.ps1` gets fixed.

**Files:**
- Create: `daemon/src/mod-installer.ts`
- Test: `daemon/test/mod-installer.test.ts`

**Interfaces:**
- Consumes: `DaemonConfig`, `ModEntry`, `ModListResponse`, `InstallResult` from `types.js`; `ModRegistry`; `SteamCmd`.
- Produces: `class ModInstaller` with `constructor(cfg: DaemonConfig, registry: ModRegistry, steam: SteamCmd)`, `list(): Promise<ModListResponse>`, `install(id: string, name: string, onLine: (l: string) => void): Promise<InstallResult>`, `updateAll(onLine: (l: string) => void): Promise<InstallResult[]>`, `remove(id: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`daemon/test/mod-installer.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModInstaller } from "../src/mod-installer.js";
import { ModRegistry } from "../src/mod-registry.js";
import { SteamCmd } from "../src/steamcmd.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { DaemonConfig } from "../src/types.js";

let modsDir: string;
let steamRoot: string;
let cfg: DaemonConfig;
let registry: ModRegistry;
let steam: SteamCmd;
let installer: ModInstaller;

/** Places a jar where steamcmd would have downloaded it, then reports success. */
function fakeSteam(jarByModId: Record<string, string | null>): SteamCmd {
  const s = new SteamCmd(cfg, (() => {
    throw new Error("spawn should not be called");
  }) as never);
  vi.spyOn(s, "downloadWorkshopItem").mockImplementation(async (id: string) => {
    const jar = jarByModId[id];
    if (jar === null || jar === undefined) {
      return { ok: false, exitCode: 8, output: `ERROR! Download item ${id} failed (Failure).` };
    }
    const dir = s.workshopItemDir(id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, jar), "jarbytes");
    return { ok: true, exitCode: 0, output: `Success. Downloaded item ${id}` };
  });
  return s;
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "necesse-inst-"));
  modsDir = join(root, "mods");
  steamRoot = join(root, "steam");
  await mkdir(modsDir, { recursive: true });
  await mkdir(steamRoot, { recursive: true });
  cfg = { ...DEFAULT_CONFIG, modsDir, steamcmdExe: join(steamRoot, "steamcmd.exe") };
  registry = new ModRegistry(join(root, "mods.json"));
});

function build(jars: Record<string, string | null>): ModInstaller {
  steam = fakeSteam(jars);
  installer = new ModInstaller(cfg, registry, steam);
  return installer;
}

describe("install", () => {
  it("copies the downloaded jar into the mods dir and records it", async () => {
    const inst = build({ "3731244177": "SafeHavenQOL-1.2.0-2.6.jar" });
    const r = await inst.install("3731244177", "Safe Haven QOL", () => {});
    expect(r.ok).toBe(true);
    expect(await readdir(modsDir)).toEqual(["SafeHavenQOL-1.2.0-2.6.jar"]);
    expect((await registry.get("3731244177"))?.jar).toBe("SafeHavenQOL-1.2.0-2.6.jar");
  });

  it("deletes the previously recorded jar when the version filename changes", async () => {
    await build({ "3731244177": "SafeHavenQOL-1.2.0-2.6.jar" }).install("3731244177", "Safe Haven QOL", () => {});
    const r = await build({ "3731244177": "SafeHavenQOL-1.2.0-2.7.jar" }).install(
      "3731244177",
      "Safe Haven QOL",
      () => {},
    );
    expect(await readdir(modsDir)).toEqual(["SafeHavenQOL-1.2.0-2.7.jar"]);
    expect(r.replacedJar).toBe("SafeHavenQOL-1.2.0-2.6.jar");
  });

  it("fails with steamcmd's output and writes nothing when the download fails", async () => {
    const r = await build({ "999": null }).install("999", "Nope", () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ERROR! Download item 999 failed");
    expect(await readdir(modsDir)).toEqual([]);
    expect(await registry.get("999")).toBeUndefined();
  });

  it("fails clearly when the download produced no jar", async () => {
    const inst = build({});
    vi.spyOn(steam, "downloadWorkshopItem").mockResolvedValue({
      ok: true,
      exitCode: 0,
      output: "Success.",
    });
    const r = await inst.install("555", "Ghost", () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no \.jar/i);
  });

  it("adopts an untracked jar when its filename matches the download", async () => {
    await writeFile(join(modsDir, "AutoTorch-1.0.jar"), "old");
    const inst = build({ "3754847143": "AutoTorch-1.0.jar" });
    await inst.install("3754847143", "AutoTorch", () => {});
    const list = await inst.list();
    expect(list.untracked).toEqual([]);
    expect(list.managed.map((m) => m.id)).toEqual(["3754847143"]);
  });
});

describe("list", () => {
  it("separates managed entries from untracked jars", async () => {
    const inst = build({ "3754847143": "AutoTorch-1.0.jar" });
    await inst.install("3754847143", "AutoTorch", () => {});
    await writeFile(join(modsDir, "MysteryMod.jar"), "x");
    await writeFile(join(modsDir, "modlist.data"), "not a jar");
    const list = await inst.list();
    expect(list.managed.map((m) => m.name)).toEqual(["AutoTorch"]);
    expect(list.untracked).toEqual([{ jar: "MysteryMod.jar" }]);
  });

  it("reports a managed mod whose jar has vanished from disk as untracked-free but still managed", async () => {
    const inst = build({ "3754847143": "AutoTorch-1.0.jar" });
    await inst.install("3754847143", "AutoTorch", () => {});
    const list = await inst.list();
    expect(list.managed).toHaveLength(1);
  });
});

describe("updateAll", () => {
  it("continues past a failing mod and reports each result", async () => {
    await build({ "1": "A-1.jar" }).install("1", "A", () => {});
    await build({ "2": "B-1.jar" }).install("2", "B", () => {});
    const inst = build({ "1": null, "2": "B-2.jar" });
    const results = await inst.updateAll(() => {});
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.id === "1")?.ok).toBe(false);
    expect(results.find((r) => r.id === "2")?.ok).toBe(true);
    const files = await readdir(modsDir);
    expect(files).toContain("A-1.jar");
    expect(files).toContain("B-2.jar");
    expect(files).not.toContain("B-1.jar");
  });

  it("returns an empty array when nothing is managed", async () => {
    expect(await build({}).updateAll(() => {})).toEqual([]);
  });
});

describe("remove", () => {
  it("deletes the jar and the registry entry", async () => {
    const inst = build({ "3754847143": "AutoTorch-1.0.jar" });
    await inst.install("3754847143", "AutoTorch", () => {});
    await inst.remove("3754847143");
    expect(await readdir(modsDir)).toEqual([]);
    expect(await registry.get("3754847143")).toBeUndefined();
  });

  it("throws for an unknown id", async () => {
    await expect(build({}).remove("nope")).rejects.toThrow(/not managed/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon; npx vitest run test/mod-installer.test.ts`
Expected: FAIL — cannot resolve `../src/mod-installer.js`.

- [ ] **Step 3: Implement `src/mod-installer.ts`**

```ts
import { copyFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModRegistry } from "./mod-registry.js";
import type { SteamCmd } from "./steamcmd.js";
import type { DaemonConfig, InstallResult, ModListResponse } from "./types.js";

export class ModInstaller {
  constructor(
    private cfg: DaemonConfig,
    private registry: ModRegistry,
    private steam: SteamCmd,
  ) {}

  async list(): Promise<ModListResponse> {
    const managed = await this.registry.load();
    const known = new Set(managed.map((m) => m.jar.toLowerCase()));
    let files: string[] = [];
    try {
      files = await readdir(this.cfg.modsDir);
    } catch {
      files = [];
    }
    const untracked = files
      .filter((f) => f.toLowerCase().endsWith(".jar") && !known.has(f.toLowerCase()))
      .map((jar) => ({ jar }));
    return { managed, untracked };
  }

  async install(id: string, name: string, onLine: (line: string) => void): Promise<InstallResult> {
    const result = await this.steam.downloadWorkshopItem(id, onLine);
    if (!result.ok) {
      return { id, name, jar: null, ok: false, error: result.output };
    }

    const dir = this.steam.workshopItemDir(id);
    let jar: string | undefined;
    try {
      jar = (await readdir(dir)).find((f) => f.toLowerCase().endsWith(".jar"));
    } catch (e) {
      return { id, name, jar: null, ok: false, error: `Cannot read ${dir}: ${(e as Error).message}` };
    }
    if (!jar) {
      return {
        id,
        name,
        jar: null,
        ok: false,
        error: `steamcmd reported success but no .jar was found in ${dir}`,
      };
    }

    try {
      await copyFile(join(dir, jar), join(this.cfg.modsDir, jar));
    } catch (e) {
      return { id, name, jar: null, ok: false, error: `Failed to copy ${jar}: ${(e as Error).message}` };
    }

    const previous = await this.registry.get(id);
    let replacedJar: string | undefined;
    if (previous && previous.jar !== jar) {
      // Necesse loads every jar in the folder, so leaving the old one duplicates the mod.
      await rm(join(this.cfg.modsDir, previous.jar), { force: true });
      replacedJar = previous.jar;
    }

    await this.registry.upsert({ id, name, jar, lastUpdated: new Date().toISOString() });
    return { id, name, jar, ok: true, replacedJar };
  }

  async updateAll(onLine: (line: string) => void): Promise<InstallResult[]> {
    const managed = await this.registry.load();
    const results: InstallResult[] = [];
    for (const mod of managed) {
      onLine(`--- Updating ${mod.name} (${mod.id})`);
      try {
        results.push(await this.install(mod.id, mod.name, onLine));
      } catch (e) {
        results.push({ id: mod.id, name: mod.name, jar: null, ok: false, error: (e as Error).message });
      }
    }
    return results;
  }

  async remove(id: string): Promise<void> {
    const entry = await this.registry.remove(id);
    if (!entry) throw new Error(`Mod ${id} is not managed by this daemon.`);
    await rm(join(this.cfg.modsDir, entry.jar), { force: true });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd daemon; npx vitest run test/mod-installer.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add daemon/src/mod-installer.ts daemon/test/mod-installer.test.ts
git commit -m "feat(daemon): mod installer replacing stale jars instead of accumulating them"
```

---

### Task 8: HTTP + WebSocket API

**Files:**
- Create: `daemon/src/http.ts`
- Test: `daemon/test/http.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-7.
- Produces:
  - `interface Deps { cfg: DaemonConfig; configFile: string; pm: ProcessManager; installer: ModInstaller; steam: SteamCmd }`
  - `buildServer(deps: Deps): FastifyInstance`
  - `broadcast(msg: WsMessage): void` exposed as `server.decorate` — Task 9 does not need it; `index.ts` does not either, since `buildServer` wires the ProcessManager events itself.

- [ ] **Step 1: Write the failing test**

`daemon/test/http.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/http.js";
import { ProcessManager } from "../src/process-manager.js";
import { ModInstaller } from "../src/mod-installer.js";
import { ModRegistry } from "../src/mod-registry.js";
import { SteamCmd } from "../src/steamcmd.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { makeFakeSpawn } from "./fixtures/fake-spawn.js";
import type { DaemonConfig } from "../src/types.js";
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon; npx vitest run test/http.test.ts`
Expected: FAIL — cannot resolve `../src/http.js`.

- [ ] **Step 3: Implement `src/http.ts`**

```ts
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { saveConfig } from "./config.js";
import { listWorlds, worldExists, isValidWorldName } from "./worlds.js";
import type { ModInstaller } from "./mod-installer.js";
import type { ProcessManager } from "./process-manager.js";
import type { SteamCmd } from "./steamcmd.js";
import type { DaemonConfig, TaskKind, WsMessage } from "./types.js";

export interface Deps {
  cfg: DaemonConfig;
  configFile: string;
  pm: ProcessManager;
  installer: ModInstaller;
  steam: SteamCmd;
}

const WORKSHOP_ID = /^\d+$/;

export function buildServer(deps: Deps): FastifyInstance {
  const { cfg, configFile, pm, installer, steam } = deps;
  const app = Fastify({ logger: false });
  const sockets = new Set<{ send(data: string): void }>();
  let taskSeq = 0;

  const broadcast = (msg: WsMessage): void => {
    const data = JSON.stringify(msg);
    for (const s of sockets) {
      try {
        s.send(data);
      } catch {
        // A dead socket is removed on close; a failed send is not worth surfacing.
      }
    }
  };

  pm.on("line", (l) => broadcast({ type: "console", line: l.line, ts: l.ts }));
  pm.on("state", (status) => {
    broadcast({ type: "status", status });
    if (status.state === "running" && status.world) {
      cfg.lastWorld = status.world;
      void saveConfig(configFile, cfg);
    }
  });

  const requireStopped = (reply: { code(c: number): unknown }): boolean => {
    const state = pm.status.state;
    if (state === "stopped" || state === "crashed") return true;
    reply.code(409);
    return false;
  };

  const runTask = (
    kind: TaskKind,
    fn: (onLine: (l: string) => void) => Promise<{ ok: boolean; error?: string }>,
  ): string => {
    const taskId = `t${++taskSeq}`;
    const onLine = (line: string) => broadcast({ type: "task", taskId, kind, line });
    void fn(onLine)
      .then((r) => broadcast({ type: "task-done", taskId, kind, ok: r.ok, error: r.error }))
      .catch((e: Error) =>
        broadcast({ type: "task-done", taskId, kind, ok: false, error: e.message }),
      );
    return taskId;
  };

  void app.register(cors, { origin: true });
  void app.register(websocket);

  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket) => {
      sockets.add(socket);
      socket.send(
        JSON.stringify({ type: "backlog", lines: pm.backlog, status: pm.status } satisfies WsMessage),
      );
      socket.on("close", () => sockets.delete(socket));
    });
  });

  app.get("/api/status", async () => pm.status);

  app.get("/api/worlds", async (req) => {
    const name = (req.query as { name?: string }).name;
    const worlds = await listWorlds(cfg.worldsDir);
    const candidate =
      name === undefined
        ? null
        : {
            name,
            valid: isValidWorldName(name),
            exists: isValidWorldName(name) ? await worldExists(cfg.worldsDir, name) : false,
          };
    return { worlds, lastWorld: cfg.lastWorld, candidate };
  });

  app.post("/api/server/start", async (req, reply) => {
    const { world } = (req.body ?? {}) as { world?: string };
    if (typeof world !== "string" || !isValidWorldName(world)) {
      return reply.code(400).send({ ok: false, error: `Invalid world name: ${JSON.stringify(world)}` });
    }
    try {
      pm.start(world);
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
    return { ok: true, status: pm.status };
  });

  app.post("/api/server/stop", async (_req, reply) => {
    try {
      await pm.stop();
      return { ok: true, status: pm.status };
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(/did not exit/.test(msg) ? 504 : 409).send({ ok: false, error: msg });
    }
  });

  app.post("/api/server/kill", async (_req, reply) => {
    try {
      pm.kill();
      return { ok: true, status: pm.status };
    } catch (e) {
      return reply.code(409).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/server/update", async (_req, reply) => {
    if (!requireStopped(reply)) {
      return reply.send({
        ok: false,
        error: `Cannot update while the server is ${pm.status.state}. Stop it first.`,
      });
    }
    const taskId = runTask("server-update", async (onLine) => {
      const r = await steam.updateApp(onLine);
      return { ok: r.ok, error: r.ok ? undefined : r.output };
    });
    return { ok: true, taskId };
  });

  app.get("/api/mods", async () => installer.list());

  app.post("/api/mods", async (req, reply) => {
    const { id, name } = (req.body ?? {}) as { id?: string; name?: string };
    if (typeof id !== "string" || !WORKSHOP_ID.test(id)) {
      return reply.code(400).send({ ok: false, error: `Invalid workshop id: ${JSON.stringify(id)}` });
    }
    if (typeof name !== "string" || name.trim().length === 0) {
      return reply.code(400).send({ ok: false, error: "Mod name is required." });
    }
    if (!requireStopped(reply)) {
      return reply.send({
        ok: false,
        error: `Cannot change mods while the server is ${pm.status.state}. Stop it first.`,
      });
    }
    const taskId = runTask("mod-install", async (onLine) => {
      const r = await installer.install(id, name.trim(), onLine);
      return { ok: r.ok, error: r.error };
    });
    return { ok: true, taskId };
  });

  app.delete("/api/mods/:id", async (req, reply) => {
    if (!requireStopped(reply)) {
      return reply.send({
        ok: false,
        error: `Cannot change mods while the server is ${pm.status.state}. Stop it first.`,
      });
    }
    const { id } = req.params as { id: string };
    try {
      await installer.remove(id);
      return { ok: true };
    } catch (e) {
      return reply.code(404).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post("/api/mods/update-all", async (_req, reply) => {
    if (!requireStopped(reply)) {
      return reply.send({
        ok: false,
        error: `Cannot update mods while the server is ${pm.status.state}. Stop it first.`,
      });
    }
    const taskId = `t${++taskSeq}`;
    const onLine = (line: string) =>
      broadcast({ type: "task", taskId, kind: "mod-update-all", line });
    void installer
      .updateAll(onLine)
      .then((results) =>
        broadcast({
          type: "task-done",
          taskId,
          kind: "mod-update-all",
          ok: results.every((r) => r.ok),
          results,
        }),
      )
      .catch((e: Error) =>
        broadcast({ type: "task-done", taskId, kind: "mod-update-all", ok: false, error: e.message }),
      );
    return { ok: true, taskId };
  });

  app.get("/api/config", async () => cfg);

  app.put("/api/config", async (req) => {
    const patch = (req.body ?? {}) as Partial<DaemonConfig>;
    Object.assign(cfg, patch);
    await saveConfig(configFile, cfg);
    return cfg;
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd daemon; npx vitest run`
Expected: PASS — all suites, 12 new tests in `http.test.ts`.

- [ ] **Step 5: Typecheck**

Run: `cd daemon; npx tsc --noEmit; "EXIT=$LASTEXITCODE"`
Expected: EXIT=0

- [ ] **Step 6: Commit**

```bash
git add daemon/src/http.ts daemon/test/http.test.ts
git commit -m "feat(daemon): HTTP and WebSocket API with running-state guards"
```

---

### Task 9: Daemon entrypoint, orphan detection, and deployment to SERVER

Ends with the daemon actually reachable from the workstation, which is the first externally verifiable deliverable.

**Files:**
- Create: `daemon/src/index.ts`, `daemon/src/orphan.ts`
- Create: `scripts/01-install-node.ps1`, `scripts/02-deploy.ps1`, `scripts/03-register-task.ps1`
- Create: `scripts/seed/config.json`, `scripts/seed/mods.json`
- Test: `daemon/test/orphan.test.ts`

**Interfaces:**
- Consumes: `buildServer`, `loadConfig`, all module constructors.
- Produces: `findOrphanServer(listProcesses: () => Promise<ProcessInfo[]>, serverJar: string): Promise<ProcessInfo | null>` and `interface ProcessInfo { pid: number; commandLine: string }`.

- [ ] **Step 1: Write the failing orphan test**

`daemon/test/orphan.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { findOrphanServer } from "../src/orphan.js";

const jar = "C:\\necesseserver\\Server.jar";

describe("findOrphanServer", () => {
  it("finds a java process running the configured Server.jar", async () => {
    const list = async () => [
      { pid: 100, commandLine: "C:\\other\\java.exe -jar Other.jar" },
      { pid: 200, commandLine: `C:\\necesseserver\\jre\\bin\\java.exe -jar ${jar} -nogui` },
    ];
    expect((await findOrphanServer(list, jar))?.pid).toBe(200);
  });

  it("matches case-insensitively, as Windows paths are", async () => {
    const list = async () => [{ pid: 7, commandLine: "java.exe -jar c:\\NECESSESERVER\\server.JAR" }];
    expect((await findOrphanServer(list, jar))?.pid).toBe(7);
  });

  it("returns null when no matching process exists", async () => {
    const list = async () => [{ pid: 1, commandLine: "notepad.exe" }];
    expect(await findOrphanServer(list, jar)).toBeNull();
  });

  it("returns null when process enumeration fails rather than throwing", async () => {
    const list = async () => {
      throw new Error("wmi unavailable");
    };
    expect(await findOrphanServer(list, jar)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon; npx vitest run test/orphan.test.ts`
Expected: FAIL — cannot resolve `../src/orphan.js`.

- [ ] **Step 3: Implement `src/orphan.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

export async function listJavaProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='java.exe' OR Name='javaw.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ],
    { windowsHide: true },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as
    | { ProcessId: number; CommandLine: string | null }
    | { ProcessId: number; CommandLine: string | null }[];
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.map((p) => ({ pid: p.ProcessId, commandLine: p.CommandLine ?? "" }));
}

export async function findOrphanServer(
  listProcesses: () => Promise<ProcessInfo[]>,
  serverJar: string,
): Promise<ProcessInfo | null> {
  let procs: ProcessInfo[];
  try {
    procs = await listProcesses();
  } catch {
    // Not being able to enumerate is not the same as there being no orphan,
    // but it must not prevent the daemon from starting.
    return null;
  }
  const needle = serverJar.toLowerCase();
  return procs.find((p) => p.commandLine.toLowerCase().includes(needle)) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd daemon; npx vitest run test/orphan.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write `src/index.ts`**

```ts
import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { buildServer } from "./http.js";
import { ModInstaller } from "./mod-installer.js";
import { ModRegistry } from "./mod-registry.js";
import { ProcessManager, type SpawnFn } from "./process-manager.js";
import { SteamCmd } from "./steamcmd.js";
import { findOrphanServer, listJavaProcesses } from "./orphan.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..");
const configFile = join(dataDir, "config.json");
const modsFile = join(dataDir, "mods.json");

const spawnFn: SpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, { cwd: opts.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }) as never;

const cfg = await loadConfig(configFile);
const pm = new ProcessManager(cfg, spawnFn);
const steam = new SteamCmd(cfg, spawnFn);
const installer = new ModInstaller(cfg, new ModRegistry(modsFile), steam);

const orphan = await findOrphanServer(listJavaProcesses, cfg.serverJar);
if (orphan) {
  pm.markUnmanaged(orphan.pid);
  console.warn(
    `A Necesse server (pid ${orphan.pid}) is already running and was not started by this daemon. ` +
      `It cannot be stopped gracefully from here.`,
  );
}

const app = buildServer({ cfg, configFile, pm, installer, steam });
await app.listen({ host: "0.0.0.0", port: cfg.port });
console.log(`necesse-daemon listening on 0.0.0.0:${cfg.port}`);
```

- [ ] **Step 6: Write the seed config and registry**

`scripts/seed/config.json`:
```json
{
  "port": 8710,
  "serverRoot": "C:\\necesseserver",
  "javaExe": "C:\\necesseserver\\jre\\bin\\java.exe",
  "serverJar": "C:\\necesseserver\\Server.jar",
  "steamcmdExe": "C:\\Users\\jeffp\\steam\\steamcmd.exe",
  "modsDir": "C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\mods",
  "worldsDir": "C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\saves\\worlds",
  "jvmArgs": [
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+UseG1GC",
    "-XX:+ExplicitGCInvokesConcurrent",
    "-XX:G1NewSizePercent=20",
    "-XX:G1ReservePercent=20",
    "-XX:MaxGCPauseMillis=50",
    "-XX:G1HeapRegionSize=32M"
  ],
  "owners": ["Jeff", "Eli"],
  "lastWorld": "Infected Toenail",
  "serverAppId": 1169370,
  "workshopAppId": 1169040,
  "stopTimeoutMs": 90000
}
```

`scripts/seed/mods.json` — derived by matching SERVER's jars against the workstation's workshop folder by exact filename:
```json
[
  { "id": "3532423990", "name": "Advanced Starter Kit", "jar": "AdvancedStarterKit-1.2.0-1.1.jar", "lastUpdated": "2026-07-26T00:00:00.000Z" },
  { "id": "3268603061", "name": "Aphorea Mod", "jar": "AphoreaMod-1.2.0-1.0.38.jar", "lastUpdated": "2026-07-26T00:00:00.000Z" },
  { "id": "3754847143", "name": "AutoTorch", "jar": "AutoTorch-1.0.jar", "lastUpdated": "2026-07-26T00:00:00.000Z" },
  { "id": "3648675157", "name": "CorruptedRaidMod", "jar": "CorruptedRaidMod.jar", "lastUpdated": "2026-07-26T00:00:00.000Z" },
  { "id": "3417452007", "name": "Extended Range", "jar": "ExtendedRange-1.2.0-1.3.jar", "lastUpdated": "2026-07-26T00:00:00.000Z" },
  { "id": "3743512839", "name": "Fishing Overhaul", "jar": "FishingOverhaul-1.2.0-1.0.1.jar", "lastUpdated": "2026-07-26T00:00:00.000Z" },
  { "id": "3531458136", "name": "NPC Shops Expanded", "jar": "NPCShopsExpanded-1.2.0-1.7.jar", "lastUpdated": "2026-07-26T00:00:00.000Z" },
  { "id": "3731244177", "name": "Safe Haven QOL", "jar": "SafeHavenQOL-1.2.0-2.6.jar", "lastUpdated": "2026-07-26T00:00:00.000Z" }
]
```

- [ ] **Step 7: Write the deployment scripts**

`scripts/01-install-node.ps1` (runs ON SERVER):
```powershell
winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
node --version
npm --version
```

`scripts/02-deploy.ps1` (runs on the workstation):
```powershell
$ErrorActionPreference = "Stop"
$key  = "$env:USERPROFILE\.ssh\necesse_server"
$repo = Split-Path -Parent $PSScriptRoot
$remote = "jeffp@192.168.1.106"
$dest = "C:/Users/jeffp/necesse-daemon"

Push-Location "$repo\daemon"
npm ci
npx tsc
Pop-Location

ssh -i $key $remote "powershell -NoProfile -Command New-Item -ItemType Directory -Force $dest | Out-Null"
scp -i $key -r "$repo\daemon\dist"          "${remote}:$dest/"
scp -i $key    "$repo\daemon\package.json"  "${remote}:$dest/"
scp -i $key    "$repo\daemon\package-lock.json" "${remote}:$dest/"

# Seed config/mods only on first deploy; never clobber live state.
ssh -i $key $remote "powershell -NoProfile -Command if (-not (Test-Path $dest/config.json)) { 'SEED_CONFIG' } else { 'KEEP_CONFIG' }"
Write-Host "If the line above says SEED_CONFIG, run:"
Write-Host "  scp -i `"$key`" `"$repo\scripts\seed\config.json`" `"${remote}:$dest/config.json`""
Write-Host "  scp -i `"$key`" `"$repo\scripts\seed\mods.json`"   `"${remote}:$dest/mods.json`""

ssh -i $key $remote "cd /d C:\Users\jeffp\necesse-daemon && npm ci --omit=dev"
Write-Host "Deployed."
```

`scripts/03-register-task.ps1` (runs ON SERVER, elevated):
```powershell
$ErrorActionPreference = "Stop"
$dir = "C:\Users\jeffp\necesse-daemon"

New-NetFirewallRule -Name necesse-daemon -DisplayName "Necesse Daemon (8710)" `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 8710 `
  -ErrorAction SilentlyContinue

$node = (Get-Command node.exe).Source
$action  = New-ScheduledTaskAction -Execute $node -Argument "dist\index.js" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "NecesseDaemon" -Action $action -Trigger $trigger `
  -Settings $settings -RunLevel Highest -Force
Start-ScheduledTask -TaskName "NecesseDaemon"
Start-Sleep -Seconds 3
Invoke-RestMethod http://localhost:8710/api/status | ConvertTo-Json
```

- [ ] **Step 8: Build and verify the daemon locally**

Run: `cd daemon; npx tsc; node -e "process.exit(0)"; npx vitest run; "EXIT=$LASTEXITCODE"`
Expected: EXIT=0, all suites pass.

- [ ] **Step 9: Deploy and verify from the workstation**

```powershell
ssh -i "$env:USERPROFILE\.ssh\necesse_server" jeffp@192.168.1.106 "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\jeffp\01-install-node.ps1"
.\scripts\02-deploy.ps1
# then run 03-register-task.ps1 on SERVER
Invoke-RestMethod http://192.168.1.106:8710/api/status
Invoke-RestMethod http://192.168.1.106:8710/api/worlds
```
Expected: status reports `stopped`; worlds lists Goober Goof, Infected Toenail, Jeff and Eli, Tulsa with no `LATEST_BACKUP*` entries.

- [ ] **Step 10: Commit**

```bash
git add daemon/src/index.ts daemon/src/orphan.ts daemon/test/orphan.test.ts scripts/
git commit -m "feat(daemon): entrypoint, orphan detection, and SERVER deployment scripts"
```

---

### Task 10: Tauri client scaffold and API layer

**Files:**
- Create: `client/` (scaffolded), `client/src/api.ts`, `client/src/useDaemon.ts`, `client/src/types.ts`
- Modify: `client/src-tauri/tauri.conf.json`
- Test: `client/test/api.test.ts`

**Interfaces:**
- Consumes: the daemon's HTTP/WS contract from Task 8.
- Produces: `api` object with `status()`, `worlds(name?)`, `start(world)`, `stop()`, `kill()`, `updateServer()`, `mods()`, `addMod(id, name)`, `removeMod(id)`, `updateAllMods()`; and `useDaemon(): DaemonState` returning `{ status, worlds, lastWorld, mods, console, connected, error, refresh }`.

- [ ] **Step 1: Scaffold**

```powershell
cd client
npx --yes create-tauri-app@latest . -m npm -t react-ts --identifier com.jpegg.necessegui -y -f
npm install
npm install -D vitest
```

- [ ] **Step 2: Copy the shared types**

Create `client/src/types.ts` containing the same type declarations as `daemon/src/types.ts` (copy verbatim: `ServerState`, `StatusPayload`, `ModEntry`, `UntrackedMod`, `ModListResponse`, `WorldInfo`, `ConsoleLine`, `TaskKind`, `InstallResult`, `WsMessage`). They are duplicated deliberately rather than shared through a workspace package — two small files beat a build-tooling dependency between two separately deployed apps.

- [ ] **Step 3: Write the failing test**

`client/test/api.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeApi } from "../src/api";

const BASE = "http://192.168.1.106:8710";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number, body: unknown) {
  return { ok: false, status, json: async () => body };
}

describe("makeApi", () => {
  it("GETs status from the configured base url", async () => {
    fetchMock.mockResolvedValue(ok({ state: "stopped" }));
    const api = makeApi(BASE);
    expect((await api.status()).state).toBe("stopped");
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/status`, expect.anything());
  });

  it("POSTs the world name as JSON on start", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    await makeApi(BASE).start("Tulsa");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/server/start`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ world: "Tulsa" });
  });

  it("throws the daemon's own error text, not a generic message", async () => {
    fetchMock.mockResolvedValue(err(409, { ok: false, error: "Server is already running" }));
    await expect(makeApi(BASE).start("Tulsa")).rejects.toThrow("Server is already running");
  });

  it("distinguishes an unreachable daemon from a daemon error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(makeApi(BASE).status()).rejects.toThrow(/could not reach the daemon/i);
  });

  it("encodes the world name in the candidate query", async () => {
    fetchMock.mockResolvedValue(ok({ worlds: [], lastWorld: null, candidate: null }));
    await makeApi(BASE).worlds("Jeff and Eli");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/worlds?name=Jeff%20and%20Eli`);
  });

  it("DELETEs a mod by id", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    await makeApi(BASE).removeMod("3731244177");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/mods/3731244177`);
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd client; npx vitest run test/api.test.ts`
Expected: FAIL — cannot resolve `../src/api`.

- [ ] **Step 5: Implement `client/src/api.ts`**

```ts
import type { ModListResponse, StatusPayload, WorldInfo } from "./types";

export interface WorldsResponse {
  worlds: WorldInfo[];
  lastWorld: string | null;
  candidate: { name: string; valid: boolean; exists: boolean } | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  } catch (e) {
    throw new Error(`Could not reach the daemon at ${url}: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

export function makeApi(base: string) {
  const post = <T>(path: string, payload?: unknown): Promise<T> =>
    request<T>(`${base}${path}`, {
      method: "POST",
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

  return {
    status: () => request<StatusPayload>(`${base}/api/status`),
    worlds: (name?: string) =>
      request<WorldsResponse>(
        name === undefined
          ? `${base}/api/worlds`
          : `${base}/api/worlds?name=${encodeURIComponent(name)}`,
      ),
    start: (world: string) => post<{ ok: true }>("/api/server/start", { world }),
    stop: () => post<{ ok: true }>("/api/server/stop"),
    kill: () => post<{ ok: true }>("/api/server/kill"),
    updateServer: () => post<{ ok: true; taskId: string }>("/api/server/update"),
    mods: () => request<ModListResponse>(`${base}/api/mods`),
    addMod: (id: string, name: string) => post<{ ok: true; taskId: string }>("/api/mods", { id, name }),
    removeMod: (id: string) =>
      request<{ ok: true }>(`${base}/api/mods/${id}`, { method: "DELETE" }),
    updateAllMods: () => post<{ ok: true; taskId: string }>("/api/mods/update-all"),
  };
}

export type Api = ReturnType<typeof makeApi>;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd client; npx vitest run test/api.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Implement `client/src/useDaemon.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { makeApi, type WorldsResponse } from "./api";
import type { ModListResponse, StatusPayload, WsMessage } from "./types";

export const DAEMON_BASE = "http://192.168.1.106:8710";
const WS_URL = "ws://192.168.1.106:8710/ws";
const CONSOLE_LIMIT = 2000;

export interface ConsoleEntry {
  line: string;
  ts: string;
  kind: "server" | "task";
}

export function useDaemon() {
  const api = useRef(makeApi(DAEMON_BASE)).current;
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [worlds, setWorlds] = useState<WorldsResponse | null>(null);
  const [mods, setMods] = useState<ModListResponse | null>(null);
  const [lines, setLines] = useState<ConsoleEntry[]>([]);
  const [connected, setConnected] = useState(false);

  const refresh = useCallback(async () => {
    const [s, w, m] = await Promise.all([api.status(), api.worlds(), api.mods()]);
    setStatus(s);
    setWorlds(w);
    setMods(m);
  }, [api]);

  const append = useCallback((entry: ConsoleEntry) => {
    setLines((prev) => {
      const next = [...prev, entry];
      return next.length > CONSOLE_LIMIT ? next.slice(next.length - CONSOLE_LIMIT) : next;
    });
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        setConnected(true);
        void refresh();
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as WsMessage;
        if (msg.type === "backlog") {
          setStatus(msg.status);
          setLines(msg.lines.map((l) => ({ line: l.line, ts: l.ts, kind: "server" })));
        } else if (msg.type === "console") {
          append({ line: msg.line, ts: msg.ts, kind: "server" });
        } else if (msg.type === "status") {
          setStatus(msg.status);
        } else if (msg.type === "task") {
          append({ line: msg.line, ts: new Date().toISOString(), kind: "task" });
        } else if (msg.type === "task-done") {
          const summary = msg.ok ? `--- ${msg.kind} finished` : `--- ${msg.kind} FAILED: ${msg.error ?? ""}`;
          append({ line: summary, ts: new Date().toISOString(), kind: "task" });
          for (const r of msg.results ?? []) {
            append({
              line: `    ${r.name} (${r.id}): ${r.ok ? `ok -> ${r.jar}` : `FAILED: ${r.error ?? ""}`}`,
              ts: new Date().toISOString(),
              kind: "task",
            });
          }
          void refresh();
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [append, refresh]);

  return { api, status, worlds, mods, lines, connected, refresh };
}
```

- [ ] **Step 8: Allow the daemon origin in the Tauri CSP**

In `client/src-tauri/tauri.conf.json`, set `app.security.csp`:
```json
"csp": "default-src 'self'; connect-src 'self' http://192.168.1.106:8710 ws://192.168.1.106:8710; style-src 'self' 'unsafe-inline'"
```
Also set `productName` to `Necesse Server GUI` and `app.windows[0].title` to the same.

- [ ] **Step 9: Commit**

```bash
git add client/
git commit -m "feat(client): Tauri scaffold, daemon API layer, and live state hook"
```

---

### Task 11: Client UI

**Files:**
- Create: `client/src/ServerHeader.tsx`, `client/src/ModsPanel.tsx`, `client/src/ConsolePanel.tsx`, `client/src/ErrorBanner.tsx`, `client/src/App.css`
- Modify: `client/src/App.tsx`
- Test: `client/test/ServerHeader.test.tsx`, `client/test/ModsPanel.test.tsx`

**Interfaces:**
- Consumes: `useDaemon`, `Api`, `WorldsResponse`, `StatusPayload`, `ModListResponse`.
- Produces: presentational components taking explicit props, so they test without a daemon:
  - `ServerHeader({ status, worlds, onStart, onStop, onKill, onUpdateServer, onCandidateChange, candidate })`
  - `ModsPanel({ mods, busy, running, onAdd, onRemove, onUpdateAll })`
  - `ConsolePanel({ lines })`
  - `ErrorBanner({ error, onDismiss })`

- [ ] **Step 1: Install test tooling**

```powershell
cd client
npm install -D @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

`@testing-library/jest-dom` is required — the tests below use `toBeDisabled()` and `toHaveValue()`, which do not exist without it.

Create `client/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

Create `client/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
```

- [ ] **Step 2: Write the failing header test**

`client/test/ServerHeader.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerHeader } from "../src/ServerHeader";
import type { StatusPayload } from "../src/types";

const stopped: StatusPayload = {
  state: "stopped", world: null, pid: null, startedAt: null,
  port: null, slots: null, gameVersion: null, lastError: null,
};
const running: StatusPayload = { ...stopped, state: "running", world: "Tulsa", pid: 42, port: 14159 };

const worlds = {
  worlds: [
    { name: "Tulsa", modifiedAt: "2026-07-25T18:40:00.000Z", sizeBytes: 1 },
    { name: "Infected Toenail", modifiedAt: "2026-07-26T04:40:00.000Z", sizeBytes: 2 },
  ],
  lastWorld: "Infected Toenail",
  candidate: null,
};

function setup(overrides: Partial<Parameters<typeof ServerHeader>[0]> = {}) {
  const props = {
    status: stopped,
    worlds,
    candidate: null,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onKill: vi.fn(),
    onUpdateServer: vi.fn(),
    onCandidateChange: vi.fn(),
    ...overrides,
  };
  render(<ServerHeader {...props} />);
  return props;
}

describe("ServerHeader", () => {
  it("prefills the world field with lastWorld", () => {
    setup();
    expect(screen.getByLabelText(/world/i)).toHaveValue("Infected Toenail");
  });

  it("lets the user type a world name that is not in the list", async () => {
    const props = setup();
    const input = screen.getByLabelText(/world/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Brand New World");
    expect(input).toHaveValue("Brand New World");
    await userEvent.click(screen.getByRole("button", { name: /^start$/i }));
    expect(props.onStart).toHaveBeenCalledWith("Brand New World");
  });

  it("warns that an unknown name will create a world", () => {
    setup({ candidate: { name: "Brand New", valid: true, exists: false } });
    expect(screen.getByText(/will create a new world/i)).toBeTruthy();
  });

  it("says an existing name will be loaded", () => {
    setup({ candidate: { name: "Tulsa", valid: true, exists: true } });
    expect(screen.getByText(/will load existing world/i)).toBeTruthy();
  });

  it("blocks Start on an invalid name", () => {
    setup({ candidate: { name: "bad:name", valid: false, exists: false } });
    expect(screen.getByRole("button", { name: /^start$/i })).toBeDisabled();
  });

  it("shows Stop instead of Start while running", () => {
    setup({ status: running });
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^start$/i })).toBeNull();
  });

  it("disables Update Server while running and explains why", () => {
    setup({ status: running });
    const btn = screen.getByRole("button", { name: /update server/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/stop/i);
  });

  it("offers kill only when unmanaged", () => {
    setup({ status: running });
    expect(screen.queryByRole("button", { name: /force kill/i })).toBeNull();
    setup({ status: { ...stopped, state: "unmanaged", pid: 999 } });
    expect(screen.getByRole("button", { name: /force kill/i })).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd client; npx vitest run test/ServerHeader.test.tsx`
Expected: FAIL — cannot resolve `../src/ServerHeader`.

- [ ] **Step 4: Implement `client/src/ServerHeader.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { StatusPayload } from "./types";
import type { WorldsResponse } from "./api";

export interface ServerHeaderProps {
  status: StatusPayload;
  worlds: WorldsResponse;
  candidate: { name: string; valid: boolean; exists: boolean } | null;
  onStart: (world: string) => void;
  onStop: () => void;
  onKill: () => void;
  onUpdateServer: () => void;
  onCandidateChange: (name: string) => void;
}

export function ServerHeader(props: ServerHeaderProps) {
  const { status, worlds, candidate } = props;
  const [world, setWorld] = useState(worlds.lastWorld ?? "");

  useEffect(() => {
    props.onCandidateChange(world);
  }, [world]);

  const busy = status.state === "starting" || status.state === "stopping";
  const live = status.state === "running" || status.state === "starting";
  const canStart = !busy && !live && world.trim().length > 0 && candidate?.valid !== false;

  return (
    <header className="header">
      <span className={`pill pill-${status.state}`}>{status.state}</span>

      <label htmlFor="world">World</label>
      <input
        id="world"
        list="world-options"
        value={world}
        disabled={live || busy}
        onChange={(e) => setWorld(e.target.value)}
      />
      <datalist id="world-options">
        {worlds.worlds.map((w) => (
          <option key={w.name} value={w.name} />
        ))}
      </datalist>

      {candidate && candidate.name.length > 0 && (
        <span className={candidate.valid ? (candidate.exists ? "hint" : "hint hint-warn") : "hint hint-bad"}>
          {!candidate.valid
            ? "Not a valid world name"
            : candidate.exists
              ? "Will load existing world"
              : "Will create a new world"}
        </span>
      )}

      {live ? (
        <button onClick={props.onStop} disabled={status.state === "stopping"}>
          Stop
        </button>
      ) : (
        <button onClick={() => props.onStart(world)} disabled={!canStart}>
          Start
        </button>
      )}

      <button
        onClick={props.onUpdateServer}
        disabled={live}
        title={live ? "Stop the server before updating it" : "Update the dedicated server via steamcmd"}
      >
        Update Server
      </button>

      {status.state === "unmanaged" && (
        <button className="danger" onClick={props.onKill} title="Risks world corruption">
          Force kill (pid {status.pid})
        </button>
      )}

      {status.lastError && <span className="hint hint-bad">{status.lastError}</span>}
    </header>
  );
}
```

- [ ] **Step 5: Run header tests to verify they pass**

Run: `cd client; npx vitest run test/ServerHeader.test.tsx`
Expected: PASS (8 tests)

- [ ] **Step 6: Write the failing mods test**

`client/test/ModsPanel.test.tsx`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModsPanel } from "../src/ModsPanel";

const mods = {
  managed: [
    { id: "3731244177", name: "Safe Haven QOL", jar: "SafeHavenQOL-1.2.0-2.6.jar", lastUpdated: "2026-07-26T00:00:00.000Z" },
  ],
  untracked: [{ jar: "MysteryMod.jar" }],
};

function setup(overrides = {}) {
  const props = {
    mods,
    busy: false,
    running: false,
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onUpdateAll: vi.fn(),
    ...overrides,
  };
  render(<ModsPanel {...props} />);
  return props;
}

describe("ModsPanel", () => {
  it("lists managed mods with id and jar", () => {
    setup();
    expect(screen.getByText("Safe Haven QOL")).toBeTruthy();
    expect(screen.getByText("3731244177")).toBeTruthy();
    expect(screen.getByText("SafeHavenQOL-1.2.0-2.6.jar")).toBeTruthy();
  });

  it("shows untracked jars labelled as not updatable", () => {
    setup();
    expect(screen.getByText("MysteryMod.jar")).toBeTruthy();
    expect(screen.getByText(/untracked/i)).toBeTruthy();
  });

  it("adds a mod from the id and name inputs", async () => {
    const props = setup();
    await userEvent.type(screen.getByLabelText(/mod id/i), "3603448084");
    await userEvent.type(screen.getByLabelText(/mod name/i), "Admin Tools");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(props.onAdd).toHaveBeenCalledWith("3603448084", "Admin Tools");
  });

  it("refuses to add a non-numeric id without calling the daemon", async () => {
    const props = setup();
    await userEvent.type(screen.getByLabelText(/mod id/i), "abc");
    await userEvent.type(screen.getByLabelText(/mod name/i), "X");
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled();
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it("removes a mod by its X button", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /remove Safe Haven QOL/i }));
    expect(props.onRemove).toHaveBeenCalledWith("3731244177");
  });

  it("disables every mutation while the server is running and says why", () => {
    setup({ running: true });
    expect(screen.getByRole("button", { name: /update all/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled();
    expect(screen.getByText(/stop the server to change mods/i)).toBeTruthy();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd client; npx vitest run test/ModsPanel.test.tsx`
Expected: FAIL — cannot resolve `../src/ModsPanel`.

- [ ] **Step 8: Implement `client/src/ModsPanel.tsx`**

```tsx
import { useState } from "react";
import type { ModListResponse } from "./types";

export interface ModsPanelProps {
  mods: ModListResponse;
  busy: boolean;
  running: boolean;
  onAdd: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onUpdateAll: () => void;
}

export function ModsPanel({ mods, busy, running, onAdd, onRemove, onUpdateAll }: ModsPanelProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const locked = busy || running;
  const canAdd = !locked && /^\d+$/.test(id.trim()) && name.trim().length > 0;

  return (
    <section className="mods">
      <div className="mods-head">
        <h2>Mods</h2>
        <button onClick={onUpdateAll} disabled={locked || mods.managed.length === 0}>
          Update All
        </button>
      </div>

      {running && <p className="hint hint-warn">Stop the server to change mods.</p>}

      <ul className="mod-list">
        {mods.managed.map((m) => (
          <li key={m.id}>
            <span className="mod-name">{m.name}</span>
            <span className="mod-id">{m.id}</span>
            <span className="mod-jar">{m.jar}</span>
            <button
              className="x"
              aria-label={`Remove ${m.name}`}
              disabled={locked}
              onClick={() => onRemove(m.id)}
            >
              &times;
            </button>
          </li>
        ))}
        {mods.untracked.map((u) => (
          <li key={u.jar} className="untracked">
            <span className="mod-name">{u.jar}</span>
            <span className="mod-id">untracked &mdash; no workshop id, cannot be updated</span>
          </li>
        ))}
      </ul>

      <div className="mod-add">
        <label htmlFor="mod-id">Mod id</label>
        <input id="mod-id" value={id} disabled={locked} onChange={(e) => setId(e.target.value)} />
        <label htmlFor="mod-name">Mod name</label>
        <input id="mod-name" value={name} disabled={locked} onChange={(e) => setName(e.target.value)} />
        <button
          disabled={!canAdd}
          onClick={() => {
            onAdd(id.trim(), name.trim());
            setId("");
            setName("");
          }}
        >
          Add
        </button>
      </div>
    </section>
  );
}
```

- [ ] **Step 9: Run mods tests to verify they pass**

Run: `cd client; npx vitest run test/ModsPanel.test.tsx`
Expected: PASS (6 tests)

- [ ] **Step 10: Implement the console, error banner, and App**

`client/src/ConsolePanel.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";
import type { ConsoleEntry } from "./useDaemon";

export function ConsolePanel({ lines }: { lines: ConsoleEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, follow]);

  return (
    <section className="console">
      <div
        className="console-body"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {lines.map((l, i) => (
          <div key={i} className={l.kind === "task" ? "line line-task" : "line"}>
            {l.line}
          </div>
        ))}
      </div>
      {!follow && <button className="follow" onClick={() => setFollow(true)}>Jump to latest</button>}
    </section>
  );
}
```

`client/src/ErrorBanner.tsx`:
```tsx
export function ErrorBanner({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      <pre>{error}</pre>
      <button onClick={onDismiss} aria-label="Dismiss error">&times;</button>
    </div>
  );
}
```

`client/src/App.tsx`:
```tsx
import { useCallback, useState } from "react";
import { ServerHeader } from "./ServerHeader";
import { ModsPanel } from "./ModsPanel";
import { ConsolePanel } from "./ConsolePanel";
import { ErrorBanner } from "./ErrorBanner";
import { useDaemon } from "./useDaemon";
import "./App.css";

export default function App() {
  const { api, status, worlds, mods, lines, connected, refresh } = useDaemon();
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<{ name: string; valid: boolean; exists: boolean } | null>(null);

  const guard = useCallback(
    (fn: () => Promise<unknown>) => () => {
      fn()
        .then(() => refresh())
        .catch((e: Error) => setError(e.message));
    },
    [refresh],
  );

  const onCandidateChange = useCallback(
    (name: string) => {
      if (name.trim().length === 0) return setCandidate(null);
      api
        .worlds(name)
        .then((r) => setCandidate(r.candidate))
        .catch(() => setCandidate(null));
    },
    [api],
  );

  if (!connected || !status || !worlds || !mods) {
    return (
      <main className="app">
        <ErrorBanner error={error} onDismiss={() => setError(null)} />
        <p className="connecting">Connecting to the daemon at 192.168.1.106:8710&hellip;</p>
      </main>
    );
  }

  const running = status.state === "running" || status.state === "starting";

  return (
    <main className="app">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <ServerHeader
        status={status}
        worlds={worlds}
        candidate={candidate}
        onCandidateChange={onCandidateChange}
        onStart={(w) => guard(() => api.start(w))()}
        onStop={guard(() => api.stop())}
        onKill={guard(() => api.kill())}
        onUpdateServer={guard(() => api.updateServer())}
      />
      <div className="body">
        <ModsPanel
          mods={mods}
          busy={false}
          running={running}
          onAdd={(id, name) => guard(() => api.addMod(id, name))()}
          onRemove={(id) => guard(() => api.removeMod(id))()}
          onUpdateAll={guard(() => api.updateAllMods())}
        />
        <ConsolePanel lines={lines} />
      </div>
    </main>
  );
}
```

`client/src/App.css`:
```css
:root { color-scheme: dark; font-family: "Segoe UI", system-ui, sans-serif; }
body { margin: 0; background: #16191d; color: #e6e9ec; }
.app { display: flex; flex-direction: column; height: 100vh; }
.header { display: flex; align-items: center; gap: .6rem; padding: .7rem 1rem; border-bottom: 1px solid #2b3138; flex-wrap: wrap; }
.header input { background: #1f242a; color: inherit; border: 1px solid #2b3138; border-radius: 4px; padding: .35rem .5rem; }
button { background: #2a3138; color: inherit; border: 1px solid #3a434c; border-radius: 4px; padding: .35rem .8rem; cursor: pointer; }
button:disabled { opacity: .45; cursor: not-allowed; }
button.danger { background: #5a2020; border-color: #7a2a2a; }
.pill { border-radius: 999px; padding: .15rem .7rem; font-size: .8rem; text-transform: uppercase; background: #333; }
.pill-running { background: #1f5136; } .pill-stopped { background: #3a3a3a; }
.pill-starting, .pill-stopping { background: #5a4a1a; }
.pill-crashed, .pill-unmanaged { background: #5a2020; }
.hint { font-size: .85rem; color: #9aa6b2; } .hint-warn { color: #e0b25c; } .hint-bad { color: #e07c7c; }
.body { display: flex; flex: 1; min-height: 0; }
.mods { width: 27rem; border-right: 1px solid #2b3138; padding: 1rem; overflow-y: auto; }
.mods-head { display: flex; justify-content: space-between; align-items: center; }
.mod-list { list-style: none; padding: 0; }
.mod-list li { display: grid; grid-template-columns: 1fr auto; gap: .15rem .5rem; padding: .5rem 0; border-bottom: 1px solid #23282e; }
.mod-name { font-weight: 600; } .mod-id, .mod-jar { grid-column: 1; font-size: .78rem; color: #8d99a5; }
.mod-list li.untracked .mod-name { color: #e0b25c; }
.x { grid-row: 1 / span 3; }
.mod-add { display: grid; grid-template-columns: auto 1fr; gap: .4rem; align-items: center; margin-top: 1rem; }
.mod-add button { grid-column: 1 / span 2; }
.console { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.console-body { flex: 1; overflow-y: auto; padding: .6rem 1rem; font-family: Consolas, monospace; font-size: .8rem; }
.line { white-space: pre-wrap; } .line-task { color: #6fd39b; }
.error { background: #4a1c1c; border-bottom: 1px solid #7a2a2a; padding: .5rem 1rem; display: flex; justify-content: space-between; gap: 1rem; }
.error pre { margin: 0; white-space: pre-wrap; font-size: .85rem; }
.connecting { padding: 2rem; color: #9aa6b2; }
```

- [ ] **Step 11: Run the full client suite and typecheck**

Run: `cd client; npx vitest run; npx tsc --noEmit; "EXIT=$LASTEXITCODE"`
Expected: EXIT=0, 20 tests pass.

- [ ] **Step 12: Commit**

```bash
git add client/src client/test client/vitest.config.ts client/package.json
git commit -m "feat(client): server header, mods panel, console, and error banner"
```

---

### Task 12: Live verification against SERVER

No new code unless a defect is found. This task exists because none of the preceding tests touch a real Necesse server, and the spec requires stating what was and was not exercised.

**Files:**
- Create: `docs/verification-2026-07-26.md`

- [ ] **Step 1: Deploy the current build**

```powershell
.\scripts\02-deploy.ps1
ssh -i "$env:USERPROFILE\.ssh\necesse_server" jeffp@192.168.1.106 "powershell -NoProfile -Command Restart-ScheduledTask -TaskName NecesseDaemon"
Invoke-RestMethod http://192.168.1.106:8710/api/status
```

- [ ] **Step 2: Confirm whether stdout carries timestamps**

Start the server from the client, then capture the first console lines. Record in the verification doc whether lines arrive as `Found mod: ...` or `[2026-07-26 22:40:42] Found mod: ...`.

If they carry no timestamps, `stripTimestamp` is a no-op and everything already works. If the format differs from **both** captured forms, fix `log-lines.ts`, add a fixture for the real format, and re-run Task 2's tests before continuing.

- [ ] **Step 3: Exercise start on an existing world**

Start `Tulsa` from the client. Confirm: state goes `starting` → `running`, the console streams mod loading, and the status pill shows port 14159.

- [ ] **Step 4: Exercise world creation**

Type a name that does not exist (`Claude Test World`). Confirm the header says "Will create a new world" *before* starting, then start it and confirm the console does **not** show `Loading existing world at`. Confirm the new zip appears in `/api/worlds` afterwards.

- [ ] **Step 5: Exercise graceful stop**

Stop from the client. Confirm the console shows `Completed world save before stopping server` and `Server has stopped`, and the state returns to `stopped`.

- [ ] **Step 6: Exercise a mod install**

Add mod id `3603448084` name `Admin Tools`. Confirm steamcmd output streams into the console, the jar lands in the mods dir on SERVER, and the row appears as managed.

```powershell
ssh -i "$env:USERPROFILE\.ssh\necesse_server" jeffp@192.168.1.106 "dir C:\Users\jeffp\AppData\Roaming\Necesse\mods"
```

- [ ] **Step 7: Exercise Update All and stale-jar replacement**

Run Update All. Confirm every managed mod reports a result and that the mods dir contains exactly one jar per managed mod — no duplicate versions of the same mod.

- [ ] **Step 8: Exercise a server update**

Run Update Server while stopped. Confirm steamcmd output streams and the task completes. Confirm the same button is refused with a clear message while running.

- [ ] **Step 9: Exercise the mod-mutation guard**

With the server running, attempt to add and to remove a mod. Confirm both are refused with "Stop the server to change mods" rather than silently queued.

- [ ] **Step 10: Write the verification record**

Create `docs/verification-2026-07-26.md` stating, per item, exactly what was run and observed. It **must** contain an explicit "Not verified" section naming at minimum:
- the `unmanaged` path (needs a server started outside the daemon),
- the `crashed` path (needs a deliberately broken mod),
- the stop-timeout path (needs a server that refuses to exit),
- concurrent clients,
- daemon restart while the server is running (the daemon loses the stdin pipe and the server becomes `unmanaged` — state this as a known limitation, not a bug).

- [ ] **Step 11: Commit**

```bash
git add docs/verification-2026-07-26.md
git commit -m "docs: live verification results against SERVER"
```

---

## Post-Plan Notes

**Known limitation to state plainly in the README:** if the daemon restarts while the Necesse server is running, it loses the stdin pipe and can only report `unmanaged`. Fixing that would require the daemon to run the server as a detached child with a named pipe, which is out of scope for v1.

**v2, already specced:** the world settings editor (see section 13 of the design doc). Its hard constraint is that unknown keys in `worldSettings.cfg` — the `rpgskills*` entries come from a mod, not the base game — must round-trip untouched.
