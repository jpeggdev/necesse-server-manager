# Shareable Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daemon's location, paths and run mode configuration rather than source, give the client a runtime connection screen with authentication, and package the result as a publishable GitHub repository.

**Architecture:** Daemon state moves out of the install directory into `%PROGRAMDATA%\NecesseServerManager`, so the install directory becomes disposable. `config.json` is produced by an interactive setup wizard instead of invented from one person's paths, `modsDir`/`worldsDir` are derived from `dataDir` so they cannot drift, and a shared bearer token guards every HTTP route and the WebSocket upgrade. The client stops hardcoding an origin: host, port and token live in `localStorage` behind a connection screen, which forces the Tauri CSP open.

**Tech Stack:** Node 22 + TypeScript (ESM, `NodeNext`) + Fastify 5 + vitest on the daemon. React 19 + Vite + Tauri 2 + vitest/RTL on the client. GitHub Actions on `windows-latest`.

**Spec:** `docs/superpowers/specs/2026-07-29-shareable-release-design.html`

## Global Constraints

- **Work on branch `feat/shareable-release`.** Never commit this work to `main`.
- **`daemon/src/types.ts` and `client/src/types.ts` must stay byte-identical.** Any task that edits one edits the other in the same commit. Task 14 verifies by hash.
- **Daemon sources must stay ES2020-library-compatible.** `daemon/tsconfig.json` pins `"lib": ["ES2020"]` because `client/test/api.integration.test.ts` typechecks every daemon file a second time under the client's ES2020 lib. No `Object.hasOwn`, `Array.prototype.at`, `findLast`. Do not raise the lib to silence an error.
- **Errors are never swallowed or reworded.** `ENOENT` is distinguished from a real failure; everything else rethrows with the path and the underlying message. A `catch` that returns a default is a defect.
- **No comments that restate the code.** Comment only a non-obvious *why*: an invariant, a workaround, a constraint the next reader would otherwise miss. Match the existing files' comment density — this codebase explains reasoning, not syntax.
- **Verify with the real tooling before claiming a task done.** From `daemon/`: `npx vitest run` and `npx tsc --noEmit`. From `client/`: `npx vitest run` and `npx tsc --noEmit`. Both packages, every task.
- **Never deploy to SERVER and never run any `scripts/0*.ps1` against it.** The game server is a child process of the live daemon. This plan is implemented and tested locally only.
- **Never create or push a public GitHub repository, and never `git push`.** Publishing is the human's call.
- **Do not run `npx tauri build` or `npm run tauri dev`.** Tauri builds are slow and spawn child processes that orphan. `tauri.conf.json` is edited as text and verified by reading it.
- **Windows paths.** Use the Read/Edit/Glob/Grep tools with native Windows paths. Bash is for `git` only.

---

### Task 1: State directory module

The single place that answers "where does daemon state live". Everything else imports from here, so the `%PROGRAMDATA%` decision has exactly one site.

**Files:**
- Create: `daemon/src/state-dir.ts`
- Test: `daemon/test/state-dir.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `stateDir(): string` — the resolved state directory.
  - `stateFile(name: string): string` — a path inside it.
  - `LEGACY_STATE_FILES: readonly string[]` — `["config.json", "mods.json", "mod-sets.json", "mod-library.json"]`, the files an old install kept beside `dist/`.
  - `LEGACY_STATE_DIRS: readonly string[]` — `["mod-library"]`.

- [ ] **Step 1: Write the failing test**

Create `daemon/test/state-dir.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";

const ENV = "NECESSE_MANAGER_DATA";
const saved = process.env[ENV];
const savedProgramData = process.env.PROGRAMDATA;

afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  if (savedProgramData === undefined) delete process.env.PROGRAMDATA;
  else process.env.PROGRAMDATA = savedProgramData;
  vi.resetModules();
});

describe("stateDir", () => {
  it("uses NECESSE_MANAGER_DATA when set", async () => {
    process.env[ENV] = "D:\\somewhere\\else";
    vi.resetModules();
    const { stateDir } = await import("../src/state-dir.js");
    expect(stateDir()).toBe("D:\\somewhere\\else");
  });

  it("falls back to PROGRAMDATA when the override is absent", async () => {
    delete process.env[ENV];
    process.env.PROGRAMDATA = "C:\\ProgramData";
    vi.resetModules();
    const { stateDir } = await import("../src/state-dir.js");
    expect(stateDir()).toBe(join("C:\\ProgramData", "NecesseServerManager"));
  });

  it("throws naming both variables when neither is available", async () => {
    delete process.env[ENV];
    delete process.env.PROGRAMDATA;
    vi.resetModules();
    const { stateDir } = await import("../src/state-dir.js");
    expect(() => stateDir()).toThrow(/NECESSE_MANAGER_DATA/);
    expect(() => stateDir()).toThrow(/PROGRAMDATA/);
  });

  it("stateFile joins onto the state directory", async () => {
    process.env[ENV] = "D:\\state";
    vi.resetModules();
    const { stateFile } = await import("../src/state-dir.js");
    expect(stateFile("config.json")).toBe(join("D:\\state", "config.json"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `daemon/`: `npx vitest run test/state-dir.test.ts`
Expected: FAIL — cannot resolve `../src/state-dir.js`.

- [ ] **Step 3: Write the implementation**

Create `daemon/src/state-dir.ts`:

```ts
import { join } from "node:path";

/**
 * Where the daemon keeps everything it cannot re-download: config.json,
 * mods.json, the mod library and the per-world sets.
 *
 * Deliberately NOT the daemon's own directory. State beside `dist/` makes
 * "delete the folder and unzip the new release" destroy the only copy of every
 * uploaded jar, and a README can warn about that but cannot prevent it. With
 * state here the install directory holds nothing irreplaceable, so
 * delete-and-replace becomes the correct upgrade rather than the dangerous one.
 *
 * Read on every call rather than cached at module load: tests set the override
 * per case, and a cached value would leak the first test's directory into the
 * rest of the file.
 */
export function stateDir(): string {
  const override = process.env.NECESSE_MANAGER_DATA;
  if (override !== undefined && override.trim().length > 0) return override;
  const programData = process.env.PROGRAMDATA;
  if (programData !== undefined && programData.trim().length > 0) {
    return join(programData, "NecesseServerManager");
  }
  throw new Error(
    "Cannot determine the daemon's state directory: neither NECESSE_MANAGER_DATA " +
      "nor PROGRAMDATA is set in this environment. Set NECESSE_MANAGER_DATA to an " +
      "absolute path to choose one explicitly.",
  );
}

export function stateFile(name: string): string {
  return join(stateDir(), name);
}

/** What an install predating the state directory kept beside `dist/`. */
export const LEGACY_STATE_FILES = [
  "config.json",
  "mods.json",
  "mod-sets.json",
  "mod-library.json",
] as const;

export const LEGACY_STATE_DIRS = ["mod-library"] as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run from `daemon/`: `npx vitest run test/state-dir.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck**

Run from `daemon/`: `npx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/state-dir.ts daemon/test/state-dir.test.ts
git commit -m "feat(daemon): resolve state to ProgramData, not the install directory"
```

---

### Task 2: Config rework

`DEFAULT_CONFIG` stops carrying one person's paths, `modsDir`/`worldsDir` become derived, `loadConfig` stops inventing a config, and `configProblems` replaces the single-purpose `dataDirConflict` check.

**Files:**
- Modify: `daemon/src/config.ts` (whole file)
- Modify: `daemon/src/types.ts` — add `authToken` to `DaemonConfig`, add `ConfigProblem`, change `PublicDaemonConfig`
- Modify: `client/src/types.ts` — identical edit
- Create: `daemon/test/fixtures/test-config.ts`
- Modify: `daemon/test/config.test.ts`

**Interfaces:**
- Consumes: `stateDir`, `stateFile` from Task 1.
- Produces:
  - `DEFAULT_CONFIG: DaemonConfig` — required path fields are `""`, not real paths.
  - `loadConfig(file: string): Promise<DaemonConfig>` — throws when the file is absent; never creates one.
  - `saveConfig(file: string, cfg: DaemonConfig): Promise<void>` — omits `modsDir`/`worldsDir`.
  - `configProblems(cfg: DaemonConfig, stored: Partial<DaemonConfig>): Promise<ConfigProblem[]>`
  - `fatalProblems(problems: ConfigProblem[]): ConfigProblem[]`
  - `makeTestConfig(root: string): DaemonConfig` from the new fixture.

- [ ] **Step 1: Add the type changes first**

In **both** `daemon/src/types.ts` and `client/src/types.ts`, add to `DaemonConfig` immediately after `steamApiKey`:

```ts
  /**
   * Shared secret every HTTP request and WebSocket upgrade must present.
   *
   * Always generated by the setup wizard, so no configuration the wizard
   * produces is unauthenticated. Its default is nonetheless the empty string,
   * which disables the check entirely: that is both the documented trusted-LAN
   * opt-out and what lets a config.json predating this field keep working. An
   * empty value here is therefore a deliberate choice, never a missing one.
   */
  authToken: string;
```

Add `configWarnings` to `StatusPayload`, after `activeTasks`:

```ts
  /**
   * Non-fatal configuration problems found at boot - currently only a missing
   * steamcmd. Carried here rather than behind its own endpoint because this
   * payload is already delivered in the websocket backlog on connect, so the
   * client can surface the problem before a user discovers it by trying to
   * install a mod. Empty when the configuration is clean.
   */
  configWarnings: string[];
```

Add after the `DaemonConfig` interface:

```ts
/**
 * One thing wrong with the configuration. `fatal` means the daemon refuses to
 * boot: the alternative is running against directories that do not exist or,
 * worse, preparing one mods folder while the game loads another.
 */
export interface ConfigProblem {
  key: keyof DaemonConfig;
  message: string;
  fatal: boolean;
}
```

Replace the `PublicDaemonConfig` definition and its doc comment with:

```ts
/**
 * What GET /api/config actually returns. Secrets are dropped entirely rather
 * than blanked in place, so there is no shape in which one could survive the
 * trip: `steamApiKey` and `authToken` each become a boolean, which is all a
 * client can act on anyway.
 */
export type PublicDaemonConfig = Omit<DaemonConfig, "steamApiKey" | "authToken"> & {
  steamApiKeyConfigured: boolean;
  authRequired: boolean;
};
```

- [ ] **Step 2: Verify the two type files are byte-identical**

Run from the repo root:

```powershell
$a = (Get-FileHash daemon\src\types.ts -Algorithm SHA256).Hash
$b = (Get-FileHash client\src\types.ts -Algorithm SHA256).Hash
"$a`n$b`nMATCH=$($a -eq $b)"
```
Expected: `MATCH=True`.

- [ ] **Step 3: Write the failing tests**

Replace the contents of `daemon/test/config.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  configProblems,
  fatalProblems,
  loadConfig,
  modsDirFor,
  saveConfig,
  worldsDirFor,
} from "../src/config.js";
import { makeTestConfig } from "./fixtures/test-config.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-config-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("throws naming the directory when no config exists, and creates nothing", async () => {
    const file = join(root, "config.json");
    await expect(loadConfig(file)).rejects.toThrow(root);
    await expect(loadConfig(file)).rejects.toThrow(/setup/i);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives modsDir and worldsDir from dataDir, ignoring what the file said", async () => {
    const file = join(root, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        dataDir: "C:\\Data\\Necesse",
        modsDir: "D:\\somewhere\\stale",
        worldsDir: "D:\\somewhere\\also-stale",
      }),
      "utf8",
    );
    const cfg = await loadConfig(file);
    expect(cfg.modsDir).toBe(modsDirFor("C:\\Data\\Necesse"));
    expect(cfg.worldsDir).toBe(worldsDirFor("C:\\Data\\Necesse"));
  });

  it("tolerates a BOM", async () => {
    const file = join(root, "config.json");
    await writeFile(file, "\uFEFF" + JSON.stringify({ port: 9999 }), "utf8");
    expect((await loadConfig(file)).port).toBe(9999);
  });

  it("reports a parse failure with the path rather than defaulting", async () => {
    const file = join(root, "config.json");
    await writeFile(file, "{ not json", "utf8");
    await expect(loadConfig(file)).rejects.toThrow(file);
  });
});

describe("saveConfig", () => {
  it("omits the derived directories so a saved config cannot carry a stale copy", async () => {
    const file = join(root, "config.json");
    await saveConfig(file, makeTestConfig(root));
    const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(written).not.toHaveProperty("modsDir");
    expect(written).not.toHaveProperty("worldsDir");
    expect(written.dataDir).toBe(join(root, "data"));
  });
});

describe("DEFAULT_CONFIG", () => {
  it("carries no machine-specific paths", async () => {
    for (const key of ["dataDir", "serverRoot", "javaExe", "serverJar", "steamcmdExe"] as const) {
      expect(DEFAULT_CONFIG[key]).toBe("");
    }
  });

  it("leaves authentication disabled by default so an older config still boots", () => {
    expect(DEFAULT_CONFIG.authToken).toBe("");
  });
});

describe("configProblems", () => {
  it("is empty for a coherent config whose paths exist", async () => {
    expect(await configProblems(makeTestConfig(root), {})).toEqual([]);
  });

  it("is fatal for each required path left empty, reporting all of them at once", async () => {
    const cfg = { ...makeTestConfig(root), serverJar: "", javaExe: "" };
    const problems = await configProblems(cfg, {});
    const keys = problems.filter((p) => p.fatal).map((p) => p.key);
    expect(keys).toContain("serverJar");
    expect(keys).toContain("javaExe");
  });

  it("is fatal when a required path is set but absent from disk", async () => {
    const cfg = { ...makeTestConfig(root), serverJar: join(root, "nope", "Server.jar") };
    const problems = await configProblems(cfg, {});
    expect(problems.some((p) => p.key === "serverJar" && p.fatal)).toBe(true);
  });

  it("warns rather than refuses when steamcmd is missing", async () => {
    const cfg = { ...makeTestConfig(root), steamcmdExe: join(root, "nope", "steamcmd.exe") };
    const problems = await configProblems(cfg, {});
    const steam = problems.find((p) => p.key === "steamcmdExe");
    expect(steam).toBeDefined();
    expect(steam?.fatal).toBe(false);
    expect(fatalProblems(problems)).toEqual([]);
  });

  it("does not treat an empty authToken as a problem", async () => {
    const problems = await configProblems({ ...makeTestConfig(root), authToken: "" }, {});
    expect(problems.some((p) => p.key === "authToken")).toBe(false);
  });

  it("is fatal when a legacy stored modsDir disagrees with dataDir", async () => {
    const cfg = makeTestConfig(root);
    const problems = await configProblems(cfg, { modsDir: "C:\\Users\\someoneelse\\mods" });
    const drift = problems.find((p) => p.key === "modsDir");
    expect(drift?.fatal).toBe(true);
    expect(drift?.message).toContain("C:\\Users\\someoneelse\\mods");
  });

  it("accepts a legacy stored modsDir that agrees, allowing for case and separators", async () => {
    const cfg = makeTestConfig(root);
    const problems = await configProblems(cfg, {
      modsDir: cfg.modsDir.toLowerCase().replace(/\\/g, "/") + "\\",
      worldsDir: cfg.worldsDir,
    });
    expect(problems.some((p) => p.key === "modsDir" || p.key === "worldsDir")).toBe(false);
  });
});
```

Create `daemon/test/fixtures/test-config.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, modsDirFor, worldsDirFor } from "../../src/config.js";
import type { DaemonConfig } from "../../src/types.js";

/**
 * A coherent config rooted in a temp directory, with every path it names
 * actually created. Exists because DEFAULT_CONFIG deliberately carries no
 * paths any more: a test that spread it and set two fields would be testing a
 * configuration `configProblems` is supposed to reject.
 */
export function makeTestConfig(root: string): DaemonConfig {
  const dataDir = join(root, "data");
  const serverRoot = join(root, "server");
  const serverJar = join(serverRoot, "Server.jar");
  const javaExe = join(serverRoot, "jre", "bin", "java.exe");
  const steamcmdExe = join(root, "steam", "steamcmd.exe");
  for (const dir of [
    dataDir,
    modsDirFor(dataDir),
    worldsDirFor(dataDir),
    join(serverRoot, "jre", "bin"),
    join(root, "steam"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const file of [serverJar, javaExe, steamcmdExe]) writeFileSync(file, "");
  return {
    ...DEFAULT_CONFIG,
    dataDir,
    modsDir: modsDirFor(dataDir),
    worldsDir: worldsDirFor(dataDir),
    serverRoot,
    serverJar,
    javaExe,
    steamcmdExe,
    modLibraryDir: join(root, "mod-library"),
    modLibraryFile: join(root, "mod-library.json"),
    modSetsFile: join(root, "mod-sets.json"),
  };
}
```

- [ ] **Step 4: Run tests to verify they fail**

Run from `daemon/`: `npx vitest run test/config.test.ts`
Expected: FAIL — `configProblems` and `fatalProblems` are not exported.

- [ ] **Step 5: Rewrite `daemon/src/config.ts`**

Keep `stripBom`, `BOM_CODE_POINT`, `modsDirFor`, `worldsDirFor` and `samePath` exactly as they are. Replace `DAEMON_DIR`, `DEFAULT_DATA_DIR`, `DEFAULT_CONFIG`, `loadConfig`, `saveConfig` and `dataDirConflict` with:

```ts
import { access } from "node:fs/promises";
import { stateFile } from "./state-dir.js";
import type { ConfigProblem, DaemonConfig } from "./types.js";

/**
 * The shipped defaults, and only the ones that are true of every installation.
 *
 * The five path fields are deliberately empty rather than pointed at plausible
 * locations. An empty value fails `configProblems` and refuses the boot with a
 * message naming the wizard; a plausible-looking default would instead start a
 * daemon confidently managing directories that do not exist on this machine,
 * which is what the previous version of this file did.
 */
export const DEFAULT_CONFIG: DaemonConfig = {
  port: 8710,
  serverRoot: "",
  javaExe: "",
  serverJar: "",
  steamcmdExe: "",
  dataDir: "",
  modsDir: "",
  worldsDir: "",
  modLibraryDir: stateFile("mod-library"),
  modLibraryFile: stateFile("mod-library.json"),
  modSetsFile: stateFile("mod-sets.json"),
  modUploadMaxBytes: 64 * 1024 * 1024,
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
  steamApiKey: "",
  authToken: "",
};

/**
 * What is actually written to disk: the derived directories are omitted so a
 * saved config can never carry a stale copy of them.
 */
export type StoredConfig = Omit<DaemonConfig, "modsDir" | "worldsDir">;

/** The raw parsed file, before defaults - what `configProblems` needs to see the legacy keys. */
export async function readStoredConfig(file: string): Promise<Partial<DaemonConfig>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No config.json in ${dirname(file)}. Run setup.cmd from the daemon's install ` +
          `folder to create one.`,
      );
    }
    throw new Error(`Failed to read config at ${file}: ${(e as Error).message}`);
  }
  try {
    // Hand-editing this file on Windows is the documented way to set the Steam
    // key, and Notepad, VS Code and PowerShell's Set-Content -Encoding UTF8 all
    // add a BOM that JSON.parse rejects. Tolerate it rather than refuse to boot.
    return JSON.parse(stripBom(raw)) as Partial<DaemonConfig>;
  } catch (e) {
    throw new Error(`Failed to parse config at ${file}: ${(e as Error).message}`);
  }
}

export async function loadConfig(file: string): Promise<DaemonConfig> {
  const parsed = await readStoredConfig(file);
  const merged = { ...DEFAULT_CONFIG, ...parsed };
  // Always derived, never read from the file. The game is launched with
  // -datadir and computes these two itself; a stored copy is a second source of
  // truth for the same fact, and the only thing a second source of truth can do
  // is disagree. A file that still carries them is not silently corrected -
  // configProblems refuses the boot, because someone whose config drifted holds
  // a wrong belief about where their mods live.
  return {
    ...merged,
    modsDir: modsDirFor(merged.dataDir),
    worldsDir: worldsDirFor(merged.dataDir),
  };
}

export async function saveConfig(file: string, cfg: DaemonConfig): Promise<void> {
  const { modsDir: _m, worldsDir: _w, ...stored } = cfg;
  await writeFile(file, JSON.stringify(stored satisfies StoredConfig, null, 2), "utf8");
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Failed to check ${p}: ${(e as Error).message}`);
  }
};

/** Required paths, and whether a missing one stops the daemon booting. */
const REQUIRED_PATHS: ReadonlyArray<{ key: keyof DaemonConfig; label: string; fatal: boolean }> = [
  { key: "dataDir", label: "the game's data directory", fatal: true },
  { key: "serverJar", label: "the dedicated server jar", fatal: true },
  { key: "javaExe", label: "the Java executable", fatal: true },
  { key: "serverRoot", label: "the server install directory", fatal: true },
  // Not fatal: starting, stopping and world management never touch steamcmd.
  // Only mod installs and server updates do, and refusing to boot over a
  // feature the operator may not use would be worse than saying so and running.
  { key: "steamcmdExe", label: "steamcmd", fatal: false },
];

/**
 * Everything wrong with this configuration, in one pass.
 *
 * All of them, not the first: a user fixing one path per restart is a worse
 * experience than one list. `stored` is the raw parsed file, which is how the
 * legacy `modsDir`/`worldsDir` keys are seen at all - `cfg` has already had
 * them overwritten with the derived values by `loadConfig`.
 */
export async function configProblems(
  cfg: DaemonConfig,
  stored: Partial<DaemonConfig>,
): Promise<ConfigProblem[]> {
  const problems: ConfigProblem[] = [];

  for (const { key, label, fatal } of REQUIRED_PATHS) {
    const value = cfg[key] as string;
    if (value.trim().length === 0) {
      problems.push({
        key,
        fatal,
        message: `"${key}" is not set, and it names ${label}. Run setup.cmd to configure it.`,
      });
      continue;
    }
    if (!(await exists(value))) {
      problems.push({
        key,
        fatal,
        message: `"${key}" is set to "${value}", which does not exist. It names ${label}.`,
      });
    }
  }

  for (const key of ["modsDir", "worldsDir"] as const) {
    const legacy = stored[key];
    if (typeof legacy !== "string" || legacy.trim().length === 0) continue;
    if (samePath(legacy, cfg[key])) continue;
    problems.push({
      key,
      fatal: true,
      message:
        `config.json still carries "${key}": "${legacy}", but dataDir "${cfg.dataDir}" ` +
        `requires "${cfg[key]}". The daemon reads and writes that folder while the game is ` +
        `launched with -datadir, so if they disagree the daemon prepares one mods folder and ` +
        `the game loads another - a wrong-mod-set launch that neither side reports as a ` +
        `failure. Delete the "${key}" line from config.json, or fix dataDir.`,
    });
  }

  return problems;
}

export const fatalProblems = (problems: ConfigProblem[]): ConfigProblem[] =>
  problems.filter((p) => p.fatal);
```

Adjust the imports at the top of the file to `import { readFile, writeFile } from "node:fs/promises";` plus `import { dirname, join, resolve } from "node:path";` — `fileURLToPath` and the `DAEMON_DIR` export are both gone.

- [ ] **Step 6: Fix every remaining reference to the removed exports**

Run from the repo root: search for `DAEMON_DIR` and `dataDirConflict`.

```powershell
Select-String -Path daemon\src\*.ts,daemon\test\*.ts,client\src\*.ts,client\test\*.ts -Pattern "DAEMON_DIR|dataDirConflict"
```

Expected remaining hits: `daemon/src/index.ts` only, which Task 5 rewrites. Leave it broken for now **only if** Task 5 is the very next task; otherwise stub the call site by importing `configProblems`/`fatalProblems` and throwing on the first fatal problem. Do not delete the check.

- [ ] **Step 7: Run tests to verify they pass**

Run from `daemon/`: `npx vitest run test/config.test.ts`
Expected: PASS.

Then the full suite: `npx vitest run`
Expected: `client/test/api.integration.test.ts` is not run from here. Some daemon tests that spread `DEFAULT_CONFIG` may now fail because paths are empty. Fix each by using `makeTestConfig(root)` from the new fixture rather than by putting paths back into `DEFAULT_CONFIG`.

- [ ] **Step 8: Typecheck both packages**

Run from `daemon/`: `npx tsc --noEmit`
Run from `client/`: `npx tsc --noEmit`
Expected: clean, or failures only in `client/test/api.integration.test.ts` for the `DEFAULT_CONFIG` spread — fix that file to use `makeTestConfig`.

- [ ] **Step 9: Commit**

```bash
git add daemon/src/config.ts daemon/src/types.ts client/src/types.ts daemon/test/config.test.ts daemon/test/fixtures/test-config.ts
git commit -m "feat(daemon): derive the game directories and refuse to invent a config"
```

---

### Task 3: Legacy state detection and the migrate command

An existing install has its state beside `dist/`. The daemon must refuse to boot rather than silently leave it behind, and a separate command copies it across.

**Files:**
- Create: `daemon/src/migrate-state.ts`
- Create: `daemon/src/migrate-cli.ts`
- Create: `daemon/migrate.cmd`
- Test: `daemon/test/migrate-state.test.ts`

**Interfaces:**
- Consumes: `stateDir`, `LEGACY_STATE_FILES`, `LEGACY_STATE_DIRS` from Task 1.
- Produces:
  - `findLegacyState(installDir: string): Promise<string[]>` — names of legacy entries present.
  - `stateDirPopulated(dir: string): Promise<boolean>`
  - `legacyStateRefusal(installDir: string, found: string[], dir: string): string`
  - `migrateState(installDir: string, dir: string): Promise<{ copied: string[] }>`

- [ ] **Step 1: Write the failing test**

Create `daemon/test/migrate-state.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLegacyState,
  legacyStateRefusal,
  migrateState,
  stateDirPopulated,
} from "../src/migrate-state.js";

let root: string;
let install: string;
let state: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-migrate-"));
  install = join(root, "install");
  state = join(root, "state");
  await mkdir(install, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("findLegacyState", () => {
  it("is empty for a clean install directory", async () => {
    expect(await findLegacyState(install)).toEqual([]);
  });

  it("finds legacy files and the library directory", async () => {
    await writeFile(join(install, "config.json"), "{}", "utf8");
    await mkdir(join(install, "mod-library"), { recursive: true });
    const found = await findLegacyState(install);
    expect(found).toContain("config.json");
    expect(found).toContain("mod-library");
  });
});

describe("stateDirPopulated", () => {
  it("is false when the directory does not exist", async () => {
    expect(await stateDirPopulated(state)).toBe(false);
  });

  it("is true once a config lives there", async () => {
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "config.json"), "{}", "utf8");
    expect(await stateDirPopulated(state)).toBe(true);
  });
});

describe("legacyStateRefusal", () => {
  it("names both directories and the command that fixes it", () => {
    const msg = legacyStateRefusal(install, ["config.json"], state);
    expect(msg).toContain(install);
    expect(msg).toContain(state);
    expect(msg).toContain("migrate.cmd");
  });
});

describe("migrateState", () => {
  it("copies files and the library tree into the state directory", async () => {
    await writeFile(join(install, "config.json"), '{"port":8710}', "utf8");
    await mkdir(join(install, "mod-library", "abc"), { recursive: true });
    await writeFile(join(install, "mod-library", "abc", "a.jar"), "JAR", "utf8");

    const r = await migrateState(install, state);

    expect(r.copied).toContain("config.json");
    expect(r.copied).toContain("mod-library");
    expect(await readFile(join(state, "config.json"), "utf8")).toBe('{"port":8710}');
    expect(await readFile(join(state, "mod-library", "abc", "a.jar"), "utf8")).toBe("JAR");
  });

  it("leaves the originals in place, so a failed migration costs disk and not jars", async () => {
    await writeFile(join(install, "config.json"), "{}", "utf8");
    await mkdir(join(install, "mod-library", "abc"), { recursive: true });
    await writeFile(join(install, "mod-library", "abc", "a.jar"), "JAR", "utf8");

    await migrateState(install, state);

    expect((await stat(join(install, "config.json"))).isFile()).toBe(true);
    expect((await stat(join(install, "mod-library", "abc", "a.jar"))).isFile()).toBe(true);
  });

  it("refuses rather than overwriting a file already in the state directory", async () => {
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "config.json"), "EXISTING", "utf8");
    await writeFile(join(install, "config.json"), "INCOMING", "utf8");

    await expect(migrateState(install, state)).rejects.toThrow(/config\.json/);
    expect(await readFile(join(state, "config.json"), "utf8")).toBe("EXISTING");
  });

  it("verifies what it copied by reading it back", async () => {
    await writeFile(join(install, "mods.json"), "[]", "utf8");
    const r = await migrateState(install, state);
    expect(r.copied).toEqual(["mods.json"]);
    expect(await readFile(join(state, "mods.json"), "utf8")).toBe("[]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `daemon/`: `npx vitest run test/migrate-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `daemon/src/migrate-state.ts`:

```ts
import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { LEGACY_STATE_DIRS, LEGACY_STATE_FILES } from "./state-dir.js";

const present = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Failed to check ${p}: ${(e as Error).message}`);
  }
};

/** Which pre-move state entries this install directory still holds. */
export async function findLegacyState(installDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of [...LEGACY_STATE_FILES, ...LEGACY_STATE_DIRS]) {
    if (await present(join(installDir, name))) found.push(name);
  }
  return found;
}

/** Whether the state directory already holds anything worth keeping. */
export async function stateDirPopulated(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length > 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Failed to read the state directory ${dir}: ${(e as Error).message}`);
  }
}

export function legacyStateRefusal(installDir: string, found: string[], dir: string): string {
  return (
    `This daemon keeps its state in ${dir}, but ${installDir} still holds an older ` +
    `install's state (${found.join(", ")}) and the state directory is empty.\n\n` +
    `Run migrate.cmd from the install folder to copy it across. It copies rather than moves ` +
    `and verifies what it wrote, so the originals stay where they are until you delete them.\n\n` +
    `The daemon refuses to start rather than migrating on its own: mod-library holds the only ` +
    `copy of every uploaded and hand-placed jar, and moving that is not something a restart ` +
    `should do by itself.`
  );
}

/**
 * Copies pre-move state into the state directory and reads back what it wrote.
 *
 * Copies, never moves: a migration that fails halfway through a move has taken
 * the only copy of a jar with it. The originals are left for a human to delete
 * once the daemon is confirmed healthy, which is deliberately a separate
 * decision from running this.
 */
export async function migrateState(
  installDir: string,
  dir: string,
): Promise<{ copied: string[] }> {
  await mkdir(dir, { recursive: true });
  const copied: string[] = [];

  for (const name of LEGACY_STATE_FILES) {
    const from = join(installDir, name);
    if (!(await present(from))) continue;
    const to = join(dir, name);
    if (await present(to)) {
      throw new Error(
        `${to} already exists. Migration refuses to overwrite state that is already in ` +
          `place - compare the two by hand and delete the one you do not want.`,
      );
    }
    const bytes = await readFile(from);
    await cp(from, to);
    const back = await readFile(to);
    if (!back.equals(bytes)) {
      throw new Error(`${to} does not match ${from} after copying. Nothing was deleted.`);
    }
    copied.push(name);
  }

  for (const name of LEGACY_STATE_DIRS) {
    const from = join(installDir, name);
    if (!(await present(from))) continue;
    const to = join(dir, name);
    if (await present(to)) {
      throw new Error(
        `${to} already exists. Migration refuses to merge two mod libraries - compare them ` +
          `by hand and delete the one you do not want.`,
      );
    }
    await cp(from, to, { recursive: true });
    await verifyTree(from, to);
    copied.push(name);
  }

  return { copied };
}

/** Every file under `from` exists under `to` with identical bytes. */
async function verifyTree(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const a = join(from, entry.name);
    const b = join(to, entry.name);
    if (entry.isDirectory()) {
      await verifyTree(a, b);
      continue;
    }
    const [x, y] = await Promise.all([readFile(a), readFile(b)]);
    if (!x.equals(y)) throw new Error(`${b} does not match ${a} after copying. Nothing was deleted.`);
  }
}
```

Create `daemon/src/migrate-cli.ts`:

```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findLegacyState, migrateState, stateDirPopulated } from "./migrate-state.js";
import { stateDir } from "./state-dir.js";

const installDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = stateDir();

const found = await findLegacyState(installDir);
if (found.length === 0) {
  console.log(`Nothing to migrate: ${installDir} holds no pre-move state.`);
  process.exit(0);
}
if (await stateDirPopulated(dir)) {
  console.error(
    `${dir} is not empty. Migration will not merge two sets of state; inspect both and ` +
      `remove the one you do not want before running this again.`,
  );
  process.exit(1);
}

console.log(`Copying ${found.join(", ")}\n  from ${installDir}\n  to   ${dir}`);
const { copied } = await migrateState(installDir, dir);
console.log(
  `Copied and verified: ${copied.join(", ")}\n\n` +
    `The originals in ${installDir} were left alone. Start the daemon, confirm it is healthy, ` +
    `then delete them yourself.`,
);
```

Create `daemon/migrate.cmd`:

```bat
@echo off
setlocal
cd /d "%~dp0"
node dist\migrate-cli.js %*
endlocal
```

- [ ] **Step 4: Run test to verify it passes**

Run from `daemon/`: `npx vitest run test/migrate-state.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck**

Run from `daemon/`: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/migrate-state.ts daemon/src/migrate-cli.ts daemon/migrate.cmd daemon/test/migrate-state.test.ts
git commit -m "feat(daemon): copy pre-move state into ProgramData rather than stranding it"
```

---

### Task 4: Authentication

One authorization decision, consulted by both the HTTP routes and the WebSocket upgrade.

**Files:**
- Create: `daemon/src/auth.ts`
- Modify: `daemon/src/http.ts` — hook registration, `publicConfig`, the two stale doc comments
- Test: `daemon/test/auth.test.ts`
- Modify: `daemon/test/http.test.ts` — the existing suite must keep passing with auth disabled

**Interfaces:**
- Consumes: `DaemonConfig.authToken` from Task 2.
- Produces:
  - `tokenMatches(configured: string, presented: string | undefined): boolean`
  - `presentedToken(req: { headers: Record<string, unknown>; query: unknown }): string | undefined`
  - `AUTH_FAILURE_MESSAGE: string`

- [ ] **Step 1: Write the failing test**

Create `daemon/test/auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AUTH_FAILURE_MESSAGE, presentedToken, tokenMatches } from "../src/auth.js";

describe("tokenMatches", () => {
  it("accepts anything when no token is configured, which is the opt-out", () => {
    expect(tokenMatches("", undefined)).toBe(true);
    expect(tokenMatches("", "whatever")).toBe(true);
  });

  it("accepts the exact token", () => {
    expect(tokenMatches("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong token, an absent one, and a prefix of the right one", () => {
    expect(tokenMatches("s3cret", "wrong")).toBe(false);
    expect(tokenMatches("s3cret", undefined)).toBe(false);
    expect(tokenMatches("s3cret", "s3cre")).toBe(false);
    expect(tokenMatches("s3cret", "")).toBe(false);
  });
});

describe("presentedToken", () => {
  it("reads a bearer header, case-insensitively on the scheme", () => {
    expect(presentedToken({ headers: { authorization: "Bearer abc" }, query: {} })).toBe("abc");
    expect(presentedToken({ headers: { authorization: "bearer abc" }, query: {} })).toBe("abc");
  });

  it("reads the query parameter, which is all a WebSocket handshake can carry", () => {
    expect(presentedToken({ headers: {}, query: { token: "abc" } })).toBe("abc");
  });

  it("prefers the header when both are present", () => {
    expect(presentedToken({ headers: { authorization: "Bearer hdr" }, query: { token: "qs" } })).toBe(
      "hdr",
    );
  });

  it("is undefined for a missing or malformed header", () => {
    expect(presentedToken({ headers: {}, query: {} })).toBeUndefined();
    expect(presentedToken({ headers: { authorization: "Basic abc" }, query: {} })).toBeUndefined();
    expect(presentedToken({ headers: { authorization: "Bearer" }, query: {} })).toBeUndefined();
  });
});

describe("AUTH_FAILURE_MESSAGE", () => {
  it("tells the operator what to do rather than only that it failed", () => {
    expect(AUTH_FAILURE_MESSAGE).toMatch(/token/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `daemon/`: `npx vitest run test/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `daemon/src/auth.ts`**

```ts
import { createHash, timingSafeEqual } from "node:crypto";

export const AUTH_FAILURE_MESSAGE =
  "This daemon requires an access token. Send it as an Authorization: Bearer header, or as " +
  "?token= on the websocket URL. The token is in config.json on the server, under authToken.";

/**
 * Compared as SHA-256 digests rather than raw buffers so the comparison is
 * both constant-time and length-independent: timingSafeEqual throws on
 * mismatched lengths, and branching on length to avoid that would leak the
 * length of the real token.
 */
export function tokenMatches(configured: string, presented: string | undefined): boolean {
  // Empty configured token disables the check. This is the documented
  // trusted-LAN opt-out, and it is what lets a config.json written before this
  // feature keep working across an upgrade.
  if (configured.length === 0) return true;
  if (presented === undefined || presented.length === 0) return false;
  const a = createHash("sha256").update(configured).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

/**
 * The token this request carries, from whichever channel could carry one.
 *
 * A browser cannot set headers on a WebSocket handshake, so the socket route
 * has to accept a query parameter. Both are read here so there is exactly one
 * answer to "what did this request present" and no second path to forget.
 */
export function presentedToken(req: {
  headers: Record<string, unknown>;
  query: unknown;
}): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const [scheme, ...rest] = header.split(" ");
    const value = rest.join(" ").trim();
    if (scheme.toLowerCase() === "bearer" && value.length > 0) return value;
  }
  const q = req.query;
  if (typeof q === "object" && q !== null) {
    const token = (q as { token?: unknown }).token;
    if (typeof token === "string" && token.length > 0) return token;
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `daemon/`: `npx vitest run test/auth.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Wire it into `daemon/src/http.ts`**

Add to the imports: `import { AUTH_FAILURE_MESSAGE, presentedToken, tokenMatches } from "./auth.js";`

Immediately after `void app.register(cors, ...)` / `void app.register(websocket)` at lines 343-344, replace the cors registration and add the hook:

```ts
  void app.register(cors, {
    origin: true,
    // Named explicitly because the client now sends Authorization. With
    // origin: true @fastify/cors reflects what was asked for, but an explicit
    // list is what makes a future change to this header visible here rather
    // than as an unexplained preflight failure in the app.
    allowedHeaders: ["content-type", "authorization"],
  });
  void app.register(websocket);

  /**
   * One authorization decision for every route and for the socket upgrade.
   *
   * onRequest rather than preHandler so it runs before a body is parsed - an
   * unauthorized request should not get a 64MB upload buffered on its behalf -
   * and because @fastify/websocket runs the same lifecycle hooks for the
   * upgrade request, which is what lets the socket be guarded by this one
   * implementation instead of a second copy.
   *
   * OPTIONS is exempt: a CORS preflight never carries Authorization (the
   * browser strips it), so rejecting preflights would make every
   * cross-origin request fail with a message about a token that was, in fact,
   * about to be sent.
   */
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    if (tokenMatches(cfg.authToken, presentedToken(req))) return;
    await reply.code(401).send({ ok: false, error: AUTH_FAILURE_MESSAGE });
  });
```

Replace `publicConfig` (lines 75-84) with:

```ts
/**
 * The config as it may leave the daemon. Secrets are dropped entirely rather
 * than blanked in place, so there is no shape in which one could survive the
 * trip; a boolean is all a client can act on anyway.
 */
const publicConfig = (c: DaemonConfig): PublicDaemonConfig => {
  const { steamApiKey, authToken, ...rest } = c;
  return {
    ...rest,
    steamApiKeyConfigured: steamApiKey.trim().length > 0,
    authRequired: authToken.length > 0,
  };
};
```

Update the `ALLOWED_CONFIG_KEYS` doc comment (lines 65-72) — it currently justifies the allowlist with "the no-auth design", which is no longer the whole story:

```ts
/**
 * Fields a client may patch via PUT /api/config. Everything else (paths,
 * jvmArgs, port, app ids) is edited by hand in config.json on the machine
 * itself.
 *
 * The allowlist survives the addition of an access token rather than being
 * relaxed by it: a token establishes that the caller is trusted to control the
 * game server, not that it is trusted to repoint javaExe/serverJar/steamcmdExe
 * (or inject a -javaagent) and have the daemon spawn an arbitrary executable.
 * Those are different powers, and the token is a shared secret on a plain-HTTP
 * LAN rather than a per-user credential.
 */
```

- [ ] **Step 6: Run the whole daemon suite**

Run from `daemon/`: `npx vitest run`
Expected: PASS. Existing `http.test.ts` cases build configs whose `authToken` is `""` (via `DEFAULT_CONFIG` or `makeTestConfig`), so the hook is inert for them. If any fail with 401, the config that test builds is setting a token — fix the test, not the hook.

- [ ] **Step 7: Add daemon-side auth route tests**

Append to `daemon/test/http.test.ts` a describe block that builds a server with `authToken: "s3cret"` using the same helper the file already uses for its other cases, and asserts via `app.inject()`:

```ts
describe("access token", () => {
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

  it("lets a CORS preflight through, since it cannot carry the header", async () => {
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
});
```

Follow whatever construction pattern `http.test.ts` already uses to build its `app`; do not introduce a second one.

- [ ] **Step 8: Run tests and typecheck**

Run from `daemon/`: `npx vitest run` then `npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add daemon/src/auth.ts daemon/src/http.ts daemon/test/auth.test.ts daemon/test/http.test.ts
git commit -m "feat(daemon): guard every route and the socket upgrade with a shared token"
```

---

### Task 5: Boot wiring

`index.ts` reads config from the state directory, refuses on legacy state, refuses on fatal problems, and publishes warnings.

**Files:**
- Modify: `daemon/src/index.ts` (lines 16-40 and 84-86)
- Modify: `daemon/src/http.ts` — `Deps` gains `configWarnings`, `statusPayload()` carries it
- Modify: `daemon/src/types.ts` and `client/src/types.ts` — already done in Task 2

**Interfaces:**
- Consumes: `stateDir`/`stateFile` (Task 1), `loadConfig`/`readStoredConfig`/`configProblems`/`fatalProblems` (Task 2), `findLegacyState`/`stateDirPopulated`/`legacyStateRefusal` (Task 3).
- Produces: `Deps.configWarnings: string[]` on `buildServer`.

- [ ] **Step 1: Change the `Deps` interface and `statusPayload` in `http.ts`**

Add to `Deps`:

```ts
  /** Non-fatal configuration problems, published so a client can surface them. */
  configWarnings: string[];
```

Destructure it in `buildServer` alongside the rest, and add it to the object `statusPayload()` returns. Find `statusPayload` (it builds `{ ...pm.status, activeTasks: [...activeTasks] }`) and add `configWarnings`.

- [ ] **Step 2: Rewrite the head of `daemon/src/index.ts`**

Replace lines 16-40 with:

```ts
const here = dirname(fileURLToPath(import.meta.url));
// Where the code lives. Not where state lives - see state-dir.ts.
const installDir = join(here, "..");
const dir = stateDir();

// Before the config is even read: an install whose state is still beside dist/
// would otherwise boot against an empty state directory, silently presenting
// itself as a fresh install and leaving the real mod library behind.
const legacy = await findLegacyState(installDir);
if (legacy.length > 0 && !(await stateDirPopulated(dir))) {
  console.error(legacyStateRefusal(installDir, legacy, dir));
  process.exit(1);
}

const configFile = join(dir, "config.json");
const modsFile = join(dir, "mods.json");

const stored = await readStoredConfig(configFile);
const cfg = await loadConfig(configFile);

// Before anything reads a folder or spawns anything. A daemon that reconciles
// one mods folder while the game loads another is worse than a daemon that did
// not start: the wrong-mod-set launch it produces looks entirely successful.
const problems = await configProblems(cfg, stored);
const fatal = fatalProblems(problems);
if (fatal.length > 0) {
  // Every one of them, not the first: fixing one path per restart is a worse
  // experience than one list.
  console.error(`The daemon cannot start with this configuration (${configFile}):`);
  for (const p of fatal) console.error(`  - ${p.message}`);
  process.exit(1);
}
const configWarnings = problems.filter((p) => !p.fatal).map((p) => p.message);
for (const w of configWarnings) console.warn(`Configuration warning: ${w}`);
```

Update the imports at the top of `index.ts`:

```ts
import {
  configProblems,
  fatalProblems,
  loadConfig,
  readStoredConfig,
} from "./config.js";
import { findLegacyState, legacyStateRefusal, stateDirPopulated } from "./migrate-state.js";
import { stateDir } from "./state-dir.js";
```

Remove the `dataDirConflict` import.

- [ ] **Step 3: Pass the warnings to `buildServer`**

Change line 84 to:

```ts
const app = buildServer({
  cfg,
  configFile,
  configWarnings,
  pm,
  installer,
  library,
  sets,
  steam,
  workshop,
});
```

And change the listening log to name the token state, because an operator needs to know which mode they are in:

```ts
await app.listen({ host: "0.0.0.0", port: cfg.port });
console.log(
  `necesse-daemon listening on 0.0.0.0:${cfg.port} ` +
    `(${cfg.authToken.length > 0 ? "token required" : "NO ACCESS TOKEN - anyone on this network can control the server"})`,
);
```

- [ ] **Step 4: Fix every `buildServer` call site**

```powershell
Select-String -Path daemon\test\*.ts,client\test\*.ts -Pattern "buildServer\("
```

Add `configWarnings: []` to each. Expected sites: `daemon/test/http.test.ts`, `client/test/api.integration.test.ts`.

- [ ] **Step 5: Run everything**

Run from `daemon/`: `npx vitest run` then `npx tsc --noEmit`
Run from `client/`: `npx vitest run` then `npx tsc --noEmit`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/index.ts daemon/src/http.ts daemon/test client/test
git commit -m "feat(daemon): boot from the state directory and refuse an incoherent config"
```

---

### Task 6: Setup wizard

**Files:**
- Create: `daemon/src/setup-probe.ts` (pure)
- Create: `daemon/src/setup-cli.ts` (prompting)
- Create: `daemon/setup.cmd`, `daemon/start-daemon.cmd`
- Test: `daemon/test/setup-probe.test.ts`
- Modify: `daemon/package.json` — add `"setup": "node dist/setup-cli.js"`

**Interfaces:**
- Consumes: `DEFAULT_CONFIG`, `saveConfig`, `modsDirFor`, `worldsDirFor` (Task 2); `stateDir` (Task 1).
- Produces:
  - `probeConfig(env: ProbeEnv): Promise<Probed>` where
    `ProbeEnv = { appData?: string; userProfile?: string; pathDirs: string[]; extraServerRoots: string[]; exists: (p: string) => Promise<boolean> }`
    and `Probed = { dataDir: string | null; serverRoot: string | null; serverJar: string | null; javaExe: string | null; steamcmdExe: string | null }`.
  - `generateToken(): string`

- [ ] **Step 1: Write the failing test**

Create `daemon/test/setup-probe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { generateToken, probeConfig } from "../src/setup-probe.js";

/** A fake filesystem: only the listed paths exist. */
const fsWith = (paths: string[]) => {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p: string) => Promise.resolve(set.has(p.toLowerCase()));
};

const APPDATA = "C:\\Users\\someone\\AppData\\Roaming";

describe("probeConfig", () => {
  it("finds the data directory under APPDATA", async () => {
    const dataDir = join(APPDATA, "Necesse");
    const r = await probeConfig({
      appData: APPDATA,
      pathDirs: [],
      extraServerRoots: [],
      exists: fsWith([dataDir]),
    });
    expect(r.dataDir).toBe(dataDir);
  });

  it("reports no data directory rather than guessing when APPDATA is unset", async () => {
    const r = await probeConfig({
      pathDirs: [],
      extraServerRoots: [],
      exists: fsWith([]),
    });
    expect(r.dataDir).toBeNull();
  });

  it("finds the server root by the jar inside it, and prefers the bundled jre", async () => {
    const root = "C:\\necesseserver";
    const r = await probeConfig({
      pathDirs: ["C:\\Windows\\System32"],
      extraServerRoots: [root],
      exists: fsWith([
        join(root, "Server.jar"),
        join(root, "jre", "bin", "java.exe"),
        "C:\\Windows\\System32\\java.exe",
      ]),
    });
    expect(r.serverRoot).toBe(root);
    expect(r.serverJar).toBe(join(root, "Server.jar"));
    expect(r.javaExe).toBe(join(root, "jre", "bin", "java.exe"));
  });

  it("falls back to java on PATH when the server ships no jre", async () => {
    const root = "C:\\necesseserver";
    const onPath = "C:\\Java\\bin\\java.exe";
    const r = await probeConfig({
      pathDirs: ["C:\\Java\\bin"],
      extraServerRoots: [root],
      exists: fsWith([join(root, "Server.jar"), onPath]),
    });
    expect(r.javaExe).toBe(onPath);
  });

  it("finds steamcmd on PATH", async () => {
    const r = await probeConfig({
      pathDirs: ["C:\\steamcmd"],
      extraServerRoots: [],
      exists: fsWith(["C:\\steamcmd\\steamcmd.exe"]),
    });
    expect(r.steamcmdExe).toBe("C:\\steamcmd\\steamcmd.exe");
  });

  it("finds steamcmd under the user profile when it is not on PATH", async () => {
    const p = "C:\\Users\\someone\\steam\\steamcmd.exe";
    const r = await probeConfig({
      userProfile: "C:\\Users\\someone",
      pathDirs: [],
      extraServerRoots: [],
      exists: fsWith([p]),
    });
    expect(r.steamcmdExe).toBe(p);
  });

  it("returns null for everything it cannot find rather than a plausible guess", async () => {
    const r = await probeConfig({ pathDirs: [], extraServerRoots: [], exists: fsWith([]) });
    expect(r).toEqual({
      dataDir: null,
      serverRoot: null,
      serverJar: null,
      javaExe: null,
      steamcmdExe: null,
    });
  });
});

describe("generateToken", () => {
  it("is long, url-safe and different every time", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `daemon/`: `npx vitest run test/setup-probe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `daemon/src/setup-probe.ts`**

```ts
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";

export interface ProbeEnv {
  appData?: string;
  userProfile?: string;
  pathDirs: string[];
  /** Extra places to look for a server install, most likely first. */
  extraServerRoots: string[];
  exists: (p: string) => Promise<boolean>;
}

export interface Probed {
  dataDir: string | null;
  serverRoot: string | null;
  serverJar: string | null;
  javaExe: string | null;
  steamcmdExe: string | null;
}

export const realExists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Failed to check ${p}: ${(e as Error).message}`);
  }
};

const firstExisting = async (
  candidates: string[],
  exists: (p: string) => Promise<boolean>,
): Promise<string | null> => {
  for (const c of candidates) if (await exists(c)) return c;
  return null;
};

/**
 * What this machine appears to have, or null per field.
 *
 * Null rather than a plausible-looking guess: the wizard shows the user what it
 * found and takes that as the default answer, and a guess presented in that
 * position is indistinguishable from a discovery. Every filesystem question
 * goes through `env.exists` so the whole thing is testable without a real disk.
 */
export async function probeConfig(env: ProbeEnv): Promise<Probed> {
  const dataDir =
    env.appData === undefined
      ? null
      : await firstExisting([join(env.appData, "Necesse")], env.exists);

  const serverRoots = [
    ...env.extraServerRoots,
    "C:\\necesseserver",
    "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Necesse Dedicated Server",
  ];
  let serverRoot: string | null = null;
  let serverJar: string | null = null;
  for (const root of serverRoots) {
    const jar = join(root, "Server.jar");
    if (await env.exists(jar)) {
      serverRoot = root;
      serverJar = jar;
      break;
    }
  }

  // The bundled jre first: it is the JVM the server ships and was tested with,
  // and a PATH java may be any version at all.
  const javaCandidates = [
    ...(serverRoot === null ? [] : [join(serverRoot, "jre", "bin", "java.exe")]),
    ...env.pathDirs.map((d) => join(d, "java.exe")),
  ];
  const javaExe = await firstExisting(javaCandidates, env.exists);

  const steamCandidates = [
    ...env.pathDirs.map((d) => join(d, "steamcmd.exe")),
    "C:\\steamcmd\\steamcmd.exe",
    ...(env.userProfile === undefined ? [] : [join(env.userProfile, "steam", "steamcmd.exe")]),
  ];
  const steamcmdExe = await firstExisting(steamCandidates, env.exists);

  return { dataDir, serverRoot, serverJar, javaExe, steamcmdExe };
}

/** 24 random bytes, base64url. Long enough that guessing is not a strategy. */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `daemon/`: `npx vitest run test/setup-probe.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Write `daemon/src/setup-cli.ts`**

```ts
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_CONFIG, modsDirFor, saveConfig, worldsDirFor } from "./config.js";
import { generateToken, probeConfig, realExists } from "./setup-probe.js";
import { stateDir } from "./state-dir.js";
import type { DaemonConfig } from "./types.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = async (question: string, fallback: string | null): Promise<string> => {
  const suffix = fallback === null ? "" : ` [${fallback}]`;
  const answer = (await rl.question(`${question}${suffix}\n> `)).trim();
  if (answer.length > 0) return answer;
  if (fallback === null) return "";
  return fallback;
};

const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "0.0.0.0");
  });

const dir = stateDir();
const configFile = join(dir, "config.json");

if (await realExists(configFile)) {
  const overwrite = await ask(`${configFile} already exists. Overwrite it? (yes/no)`, "no");
  if (overwrite.toLowerCase() !== "yes") {
    console.log("Left the existing configuration alone.");
    rl.close();
    process.exit(0);
  }
}

console.log(`\nLooking for a Necesse server on this machine...\n`);

const probed = await probeConfig({
  appData: process.env.APPDATA,
  userProfile: process.env.USERPROFILE,
  pathDirs: (process.env.PATH ?? "").split(delimiter).filter((d) => d.length > 0),
  extraServerRoots: [],
  exists: realExists,
});

const report = (label: string, found: string | null): void => {
  console.log(found === null ? `  ${label}: not found` : `  ${label}: ${found}`);
};
report("Game data directory", probed.dataDir);
report("Server install", probed.serverRoot);
report("Java", probed.javaExe);
report("steamcmd", probed.steamcmdExe);
console.log("");

// Read as the interactive user on purpose. This value is written into
// config.json and handed to the game as -datadir, which is exactly what lets
// the daemon later run as SYSTEM - whose own %APPDATA% is
// C:\Windows\system32\config\systemprofile and holds no worlds at all.
const dataDir = await ask(
  "Where is the game's data directory? (contains saves\\worlds and mods)",
  probed.dataDir,
);
const serverRoot = await ask("Where is the dedicated server installed?", probed.serverRoot);
const serverJar = await ask("Where is Server.jar?", probed.serverJar ?? join(serverRoot, "Server.jar"));
const javaExe = await ask("Which java.exe should run it?", probed.javaExe);
const steamcmdExe = await ask(
  "Where is steamcmd.exe? (needed only for mod installs and server updates - leave blank if you have none)",
  probed.steamcmdExe,
);

const portAnswer = await ask("Which port should the daemon listen on?", String(DEFAULT_CONFIG.port));
const port = Number(portAnswer);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`"${portAnswer}" is not a valid port number.`);
  rl.close();
  process.exit(1);
}
if (!(await portFree(port))) {
  console.warn(
    `Warning: something is already listening on port ${port}. If that is an older copy of ` +
      `this daemon, stop it before starting the new one.`,
  );
}

console.log(
  `\nA Steam Web API key is needed only for workshop search. Everything else - installing a ` +
    `mod by id, updating mods, updating the server - works without one. Get one at ` +
    `https://steamcommunity.com/dev/apikey`,
);
const steamApiKey = await ask("Steam Web API key (leave blank for none)", "");

const authToken = generateToken();

const cfg: DaemonConfig = {
  ...DEFAULT_CONFIG,
  dataDir,
  modsDir: modsDirFor(dataDir),
  worldsDir: worldsDirFor(dataDir),
  serverRoot,
  serverJar,
  javaExe,
  steamcmdExe,
  port,
  steamApiKey,
  authToken,
};

await mkdir(dir, { recursive: true });
// Written through saveConfig so the derived directories are omitted exactly as
// they are for every other write, and so there is one implementation of "what
// config.json looks like".
await saveConfig(configFile, cfg);

console.log(`\nWrote ${configFile}\n`);
console.log(`Your access token is:\n\n    ${authToken}\n`);
console.log(
  `Enter that in the client's connection screen. It is stored in config.json under ` +
    `"authToken" if you need it again.\n\n` +
    `Next: run start-daemon.cmd to run it in this window, or register-task.ps1 (as ` +
    `Administrator) to have it start automatically at boot.`,
);
rl.close();
```

Note: `saveConfig` writes plain UTF-8 with no BOM via `writeFile(..., "utf8")`, which is what the project requires. The unused `writeFile` import above should be removed if the linter flags it.

- [ ] **Step 6: Write the cmd shims**

`daemon/setup.cmd`:

```bat
@echo off
setlocal
cd /d "%~dp0"
node dist\setup-cli.js %*
endlocal
```

`daemon/start-daemon.cmd`:

```bat
@echo off
setlocal
cd /d "%~dp0"
node dist\index.js %*
endlocal
```

- [ ] **Step 7: Add the npm script**

In `daemon/package.json`, add to `scripts`:

```json
    "setup": "node dist/setup-cli.js",
```

- [ ] **Step 8: Run tests and typecheck**

Run from `daemon/`: `npx vitest run` then `npx tsc --noEmit`
Expected: clean. Do **not** run `setup-cli.js` — it blocks on stdin.

- [ ] **Step 9: Commit**

```bash
git add daemon/src/setup-probe.ts daemon/src/setup-cli.ts daemon/setup.cmd daemon/start-daemon.cmd daemon/package.json daemon/test/setup-probe.test.ts
git commit -m "feat(daemon): probe the machine and write a config instead of assuming one"
```

---

### Task 7: Client settings module

**Files:**
- Create: `client/src/settings.ts`
- Test: `client/test/settings.test.ts`

**Interfaces:**
- Produces:
  - `interface Connection { host: string; port: number; token: string }`
  - `loadConnection(): Connection | null`
  - `saveConnection(c: Connection): void`
  - `clearConnection(): void`
  - `baseUrl(c: Connection): string` — `http://host:port`
  - `wsUrl(c: Connection): string` — `ws://host:port/ws` plus `?token=` when the token is non-empty
  - `encodeConnection(c: Connection): string` / `decodeConnection(text: string): Connection | null`
  - `CONNECTION_KEY = "necesse.connection"`

- [ ] **Step 1: Write the failing test**

Create `client/test/settings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  CONNECTION_KEY,
  baseUrl,
  clearConnection,
  decodeConnection,
  encodeConnection,
  loadConnection,
  saveConnection,
  wsUrl,
} from "../src/settings";

beforeEach(() => {
  localStorage.clear();
});

describe("loadConnection", () => {
  it("is null before anything is saved", () => {
    expect(loadConnection()).toBeNull();
  });

  it("round-trips a saved connection", () => {
    saveConnection({ host: "192.168.1.106", port: 8710, token: "abc" });
    expect(loadConnection()).toEqual({ host: "192.168.1.106", port: 8710, token: "abc" });
  });

  it("treats corrupt stored data as unconfigured rather than throwing", () => {
    localStorage.setItem(CONNECTION_KEY, "not json");
    expect(loadConnection()).toBeNull();
  });

  it("treats a partial record as unconfigured", () => {
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({ host: "h" }));
    expect(loadConnection()).toBeNull();
  });

  it("rejects a stored port that is not a usable number", () => {
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({ host: "h", port: "eight", token: "" }));
    expect(loadConnection()).toBeNull();
  });

  it("accepts an empty token, which is the daemon's no-auth mode", () => {
    saveConnection({ host: "h", port: 1, token: "" });
    expect(loadConnection()).toEqual({ host: "h", port: 1, token: "" });
  });
});

describe("clearConnection", () => {
  it("removes what was saved", () => {
    saveConnection({ host: "h", port: 1, token: "" });
    clearConnection();
    expect(loadConnection()).toBeNull();
  });
});

describe("urls", () => {
  it("builds the http base", () => {
    expect(baseUrl({ host: "h", port: 8710, token: "" })).toBe("http://h:8710");
  });

  it("omits the token from the socket url when there is none", () => {
    expect(wsUrl({ host: "h", port: 8710, token: "" })).toBe("ws://h:8710/ws");
  });

  it("carries the token on the socket url, which is all a handshake can do", () => {
    expect(wsUrl({ host: "h", port: 8710, token: "a b" })).toBe("ws://h:8710/ws?token=a%20b");
  });
});

describe("encode/decode", () => {
  it("round-trips through the clipboard blob", () => {
    const c = { host: "192.168.1.106", port: 8710, token: "abc" };
    expect(decodeConnection(encodeConnection(c))).toEqual(c);
  });

  it("is null for text that is not a connection", () => {
    expect(decodeConnection("hello")).toBeNull();
    expect(decodeConnection(JSON.stringify({ host: "h" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `client/`: `npx vitest run test/settings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `client/src/settings.ts`**

```ts
/**
 * Where this app remembers which daemon to talk to.
 *
 * localStorage rather than a file behind a Tauri command: a command would be a
 * new client-to-Rust boundary that the test suite could only mock, and a mocked
 * boundary is exactly the shape that once let five actions ship broken with the
 * suite green. Portability - moving to a second workstation - is served by the
 * copy/paste blob in the settings screen instead.
 */
export interface Connection {
  host: string;
  port: number;
  /** Empty when the daemon runs with no access token, which is a supported mode. */
  token: string;
}

export const CONNECTION_KEY = "necesse.connection";

const parse = (text: string | null): Connection | null => {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Corrupt storage reads as unconfigured. Throwing here would white-screen
    // the app at startup with no route to the settings form that fixes it.
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { host, port, token } = raw as Record<string, unknown>;
  if (typeof host !== "string" || host.trim().length === 0) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof token !== "string") return null;
  return { host, port, token };
};

export const loadConnection = (): Connection | null => parse(localStorage.getItem(CONNECTION_KEY));

export const saveConnection = (c: Connection): void => {
  localStorage.setItem(CONNECTION_KEY, JSON.stringify(c));
};

export const clearConnection = (): void => {
  localStorage.removeItem(CONNECTION_KEY);
};

export const baseUrl = (c: Connection): string => `http://${c.host}:${c.port}`;

/**
 * A browser cannot set an Authorization header on a WebSocket handshake, so the
 * token rides the query string. The daemon reads both channels through one
 * check.
 */
export const wsUrl = (c: Connection): string =>
  `ws://${c.host}:${c.port}/ws` +
  (c.token.length > 0 ? `?token=${encodeURIComponent(c.token)}` : "");

export const encodeConnection = (c: Connection): string => JSON.stringify(c, null, 2);

export const decodeConnection = (text: string): Connection | null => parse(text.trim());
```

- [ ] **Step 4: Run test to verify it passes**

Run from `client/`: `npx vitest run test/settings.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Typecheck and commit**

Run from `client/`: `npx tsc --noEmit`

```bash
git add client/src/settings.ts client/test/settings.test.ts
git commit -m "feat(client): remember which daemon to talk to"
```

---

### Task 8: Transport — token threading and a terminal 401

**Files:**
- Modify: `client/src/api.ts` — `makeApi(base, token)`, header on every request including `uploadMod`
- Modify: `client/src/useDaemon.ts` — URLs from settings, 401 stops the retry loop
- Modify: `client/test/api.test.ts` — existing calls now pass a token
- Test: `client/test/api.test.ts` gains header assertions

**Interfaces:**
- Consumes: `Connection`, `baseUrl`, `wsUrl` from Task 7.
- Produces:
  - `makeApi(base: string, token: string): Api`
  - `UNAUTHORIZED_STATUS = 401`
  - `useDaemon(conn: Connection): DaemonState` — `DaemonState` gains `unauthorized: boolean`.

- [ ] **Step 1: Write the failing tests**

Add to `client/test/api.test.ts`:

```ts
describe("access token", () => {
  it("sends a bearer header on GETs", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await makeApi(BASE, "s3cret").status();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
  });

  it("sends it on bodyless POSTs without claiming a JSON body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await makeApi(BASE, "s3cret").stop();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer s3cret");
    expect(headers["content-type"]).toBeUndefined();
  });

  it("sends it on the raw-body jar upload, which builds its own request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await makeApi(BASE, "s3cret").uploadMod(new Uint8Array([1, 2, 3]), "a.jar");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer s3cret");
    expect(headers["content-type"]).toBe("application/java-archive");
  });

  it("sends no authorization header when there is no token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await makeApi(BASE, "").status();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
  });
});
```

Match the existing file's mocking helpers (`fetchMock`, `jsonResponse` or whatever it already defines) rather than introducing new ones — read the top of `client/test/api.test.ts` first and reuse them. Update every existing `makeApi(BASE)` call in that file to `makeApi(BASE, "")`.

- [ ] **Step 2: Run tests to verify they fail**

Run from `client/`: `npx vitest run test/api.test.ts`
Expected: FAIL — `makeApi` takes one argument.

- [ ] **Step 3: Change `client/src/api.ts`**

Replace the `request` helper and the `makeApi` signature:

```ts
/** The daemon answers anything without a valid access token with this. */
export const UNAUTHORIZED_STATUS = 401;

const authHeader = (token: string): Record<string, string> =>
  token.length > 0 ? { authorization: `Bearer ${token}` } : {};

async function request<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...authHeader(token),
        // Only claim a JSON body when one is actually being sent - Fastify's
        // default JSON parser rejects an empty body under this header with
        // FST_ERR_CTP_EMPTY_JSON_BODY (400), which broke every bodyless
        // mutation (stop/kill/updateServer/updateAllMods/removeMod).
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      },
    });
  } catch (e) {
    throw new Error(`Could not reach the daemon at ${url}: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new DaemonError(body?.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return body as T;
}

export function makeApi(base: string, token: string) {
  const get = <T>(path: string): Promise<T> => request<T>(`${base}${path}`, token);
  const post = <T>(path: string, payload?: unknown): Promise<T> =>
    request<T>(`${base}${path}`, token, {
      method: "POST",
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
```

Then update every call inside `makeApi` to pass `token` as the second argument to `request` (or route through `get`). In `uploadMod`, change the fetch to:

```ts
        res = await fetch(url, {
          method: "POST",
          headers: { ...authHeader(token), "content-type": "application/java-archive" },
          body: bytes as BodyInit,
        });
```

> This call deliberately bypasses `request()` because it sends a raw jar body rather than JSON, which makes it the one call that can be broken while every other action works. Task 11 covers it over a real socket.

- [ ] **Step 4: Change `client/src/useDaemon.ts`**

Delete lines 11-12 (`DAEMON_BASE`, `WS_URL`). Change the signature and the derived URLs:

```ts
import { baseUrl, wsUrl, type Connection } from "./settings";
import { UNAUTHORIZED_STATUS, makeApi, type Api, type WorldsResponse } from "./api";
import { DaemonError } from "./api";

export function useDaemon(conn: Connection): DaemonState {
  const base = baseUrl(conn);
  const socketUrl = wsUrl(conn);
  const [api] = useState<Api>(() => makeApi(base, conn.token));
  const [unauthorized, setUnauthorized] = useState(false);
```

Add `unauthorized: boolean` to the `DaemonState` interface with this comment:

```ts
  /**
   * The daemon rejected this token. Terminal, unlike every other failure: the
   * socket retries every 2s, and against a bad token that spins forever behind
   * a "connecting" message that will never resolve and never explain itself.
   * The app returns to the settings screen instead.
   */
  unauthorized: boolean;
```

In `refresh`'s catch and in `readLibrary`'s catch, set it:

```ts
      if (e instanceof DaemonError && e.status === UNAUTHORIZED_STATUS) setUnauthorized(true);
```

In `diagnoseConnectFailure`, replace `DAEMON_BASE` with `base` and `WS_URL` with `socketUrl`, and set `unauthorized` when `api.status()` rejects with a 401.

In the socket effect, guard the retry:

```ts
      ws.onclose = () => {
        if (closed) return;
        setConnected(false);
        failures += 1;
        if (failures >= WS_FAILURE_THRESHOLD) void diagnoseConnectFailure(failures);
        retry = setTimeout(connect, WS_RETRY_MS);
      };
```

becomes, with the effect gaining `unauthorized` in its dependency list and an early return:

```ts
  useEffect(() => {
    // A rejected token is not a transient failure, and retrying it forever
    // would bury the one message that tells the user what to fix.
    if (unauthorized) return;
    let ws: WebSocket | null = null;
```

Add `unauthorized` to the returned object and to the effect's dependency array.

- [ ] **Step 5: Run tests**

Run from `client/`: `npx vitest run`
Expected: `App.test.tsx` and any test rendering `<App />` now fail — Task 9 fixes them. `api.test.ts` and `settings.test.ts` pass. If `useDaemon` is rendered directly by a test, pass it `{ host: "h", port: 1, token: "" }`.

- [ ] **Step 6: Commit**

```bash
git add client/src/api.ts client/src/useDaemon.ts client/test/api.test.ts
git commit -m "feat(client): carry the access token and stop retrying a rejected one"
```

---

### Task 9: Connection screen, app gating, and the CSP

**Files:**
- Create: `client/src/ConnectionSettings.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/ServerHeader.tsx` — a settings button
- Modify: `client/src/App.css` — styles for the new screen
- Modify: `client/src-tauri/tauri.conf.json` line 22 — the CSP
- Test: `client/test/ConnectionSettings.test.tsx`
- Modify: `client/test/App.test.tsx`, `client/test/ServerHeader.test.tsx`

**Interfaces:**
- Consumes: `Connection`, `loadConnection`, `saveConnection`, `encodeConnection`, `decodeConnection`, `baseUrl` (Task 7); `makeApi`, `DaemonError`, `UNAUTHORIZED_STATUS` (Task 8).
- Produces: `<ConnectionSettings initial={Connection | null} onSave={(c: Connection) => void} onCancel={() => void} />`.

- [ ] **Step 1: Write the failing test**

Create `client/test/ConnectionSettings.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionSettings } from "../src/ConnectionSettings";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ok = () =>
  Promise.resolve({ ok: true, status: 200, statusText: "OK", json: () => Promise.resolve({}) });

describe("ConnectionSettings", () => {
  it("saves the entered host, port and token", async () => {
    const onSave = vi.fn();
    render(<ConnectionSettings initial={null} onSave={onSave} onCancel={() => {}} />);
    await userEvent.type(screen.getByLabelText(/host/i), "192.168.1.106");
    await userEvent.clear(screen.getByLabelText(/port/i));
    await userEvent.type(screen.getByLabelText(/port/i), "8710");
    await userEvent.type(screen.getByLabelText(/token/i), "s3cret");
    await userEvent.click(screen.getByRole("button", { name: /connect|save/i }));
    expect(onSave).toHaveBeenCalledWith({ host: "192.168.1.106", port: 8710, token: "s3cret" });
  });

  it("refuses to save an empty host", async () => {
    const onSave = vi.fn();
    render(<ConnectionSettings initial={null} onSave={onSave} onCancel={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /connect|save/i }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/host/i);
  });

  it("reports a successful test connection", async () => {
    fetchMock.mockImplementation(ok);
    render(
      <ConnectionSettings
        initial={{ host: "h", port: 8710, token: "" }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /test/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/connected/i);
  });

  it("distinguishes a rejected token from an unreachable daemon", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      json: () => Promise.resolve({ error: "This daemon requires an access token." }),
    });
    render(
      <ConnectionSettings
        initial={{ host: "h", port: 8710, token: "bad" }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /test/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/token/i);
  });

  it("reports an unreachable daemon distinctly", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(
      <ConnectionSettings
        initial={{ host: "h", port: 8710, token: "" }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /test/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(/could not reach/i);
  });

  it("pastes a connection blob into the fields", async () => {
    const onSave = vi.fn();
    render(<ConnectionSettings initial={null} onSave={onSave} onCancel={() => {}} />);
    const blob = JSON.stringify({ host: "pasted", port: 9000, token: "tok" });
    await userEvent.type(screen.getByLabelText(/paste/i), blob);
    await userEvent.click(screen.getByRole("button", { name: /apply pasted/i }));
    expect(screen.getByLabelText(/host/i)).toHaveValue("pasted");
    expect(screen.getByLabelText(/port/i)).toHaveValue(9000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `client/`: `npx vitest run test/ConnectionSettings.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `client/src/ConnectionSettings.tsx`**

Requirements the tests pin, to implement in the existing file's style (function component, no `React.FC`, real semantic elements, every control labelled with `<label htmlFor>`):

- Controlled inputs for host (`type="text"`), port (`type="number"`), token (`type="password"` with a show/hide toggle).
- A **Connect** (or **Save**) button that validates and calls `onSave({host, port, token})`. Invalid input renders a `role="alert"` naming the offending field and does not call `onSave`.
- A **Test connection** button that calls `makeApi(baseUrl(c), token).status()` and renders a `role="status"` element with one of: `Connected.`, a 401 message naming the token, or `Could not reach ...` carrying fetch's own message. Distinguish by catching `DaemonError` and reading `.status === UNAUTHORIZED_STATUS`.
- A **Copy** button writing `encodeConnection(current)` to `navigator.clipboard` when available, and a labelled textarea (`Paste connection details`) plus an **Apply pasted** button that runs `decodeConnection` and fills the fields, rendering a `role="alert"` when the text does not decode.
- A **Cancel** button calling `onCancel`, rendered only when `initial !== null` — there is nothing to go back to on first run.

Comment only the non-obvious: why the token defaults to empty being valid, and why Test connection distinguishes the four outcomes.

- [ ] **Step 4: Gate `App.tsx` on a stored connection**

`App.tsx` currently calls `useDaemon()` unconditionally at the top, which cannot be made conditional — hooks may not be called conditionally. Split the component:

```tsx
export default function App() {
  const [conn, setConn] = useState<Connection | null>(() => loadConnection());
  const [editing, setEditing] = useState(false);

  if (conn === null || editing) {
    return (
      <main className="app">
        <ConnectionSettings
          initial={conn}
          onSave={(c) => {
            saveConnection(c);
            setConn(c);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </main>
    );
  }

  // Keyed on the connection so switching daemons remounts the whole tree
  // rather than leaving one daemon's worlds and console on screen under
  // another daemon's status.
  return (
    <ConnectedApp
      key={`${conn.host}:${conn.port}`}
      conn={conn}
      onEditConnection={() => setEditing(true)}
    />
  );
}
```

Rename the existing component body to `function ConnectedApp({ conn, onEditConnection }: { conn: Connection; onEditConnection: () => void })`, change its `useDaemon()` call to `useDaemon(conn)`, and destructure `unauthorized` from it. Immediately after the destructuring, add:

```tsx
  // A rejected token is the one connection failure the user can only fix here.
  useEffect(() => {
    if (unauthorized) onEditConnection();
  }, [unauthorized, onEditConnection]);
```

Replace the hardcoded connecting message at line 240:

```tsx
        <p className="connecting">Connecting to the daemon at {conn.host}:{conn.port}&hellip;</p>
```

Pass `onEditConnection` down to `ServerHeader` as a new prop and render a button (`aria-label="Connection settings"`) that calls it.

- [ ] **Step 5: Surface `configWarnings`**

Where `App.tsx` already renders `libraryError` / `updatesError` style notices, render each entry of `status.configWarnings` the same way. These are daemon-side configuration problems that are not fatal — a missing steamcmd — and the point of carrying them is that the user sees them before trying to install a mod.

- [ ] **Step 6: Open the CSP**

In `client/src-tauri/tauri.conf.json`, change the `connect-src` portion of line 22 from
`connect-src 'self' http://192.168.1.106:8710 ws://192.168.1.106:8710`
to
`connect-src 'self' http: https: ws: wss:`

Leave `img-src`, `style-src` and `default-src` exactly as they are. Verify by reading the file back — do not run a Tauri build.

- [ ] **Step 7: Fix the existing component tests**

`client/test/App.test.tsx` renders `<App />`, which now shows the connection screen because `localStorage` is empty. Add a `beforeEach` that seeds it:

```ts
beforeEach(() => {
  localStorage.setItem(
    "necesse.connection",
    JSON.stringify({ host: "127.0.0.1", port: 8710, token: "" }),
  );
});
```

`ServerHeader.test.tsx` gains the new required prop. Add `onEditConnection={() => {}}` to its render helper.

- [ ] **Step 8: Run tests and typecheck**

Run from `client/`: `npx vitest run` then `npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add client/src client/test client/src-tauri/tauri.conf.json
git commit -m "feat(client): connect to a daemon the user names rather than a compiled-in one"
```

---

### Task 10: The seam — auth over a real socket

The one test that proves the client transport and the daemon agree. Everything else in this plan is one side of a boundary.

**Files:**
- Modify: `client/test/api.integration.test.ts`

- [ ] **Step 1: Parameterize the harness on a token**

Change `beforeEach` to build the config with `makeTestConfig` (Task 2's fixture) plus a token, and keep the temp-dir rule at the top of the file intact:

```ts
const TOKEN = "integration-test-token";

// ... inside beforeEach, replacing the DEFAULT_CONFIG spread:
  const cfg = {
    ...makeTestConfig(root),
    stopTimeoutMs: 50,
    modUploadMaxBytes: UPLOAD_LIMIT,
    authToken: TOKEN,
  };
```

Import it: `import { makeTestConfig } from "../../daemon/test/fixtures/test-config.js";` and drop the `DEFAULT_CONFIG` import.

`makeTestConfig` creates its own `mods`/`saves\worlds` under `root/data`, so delete the local `modsDir`/`worldsDir` `mkdir` calls and use `cfg.modsDir` / `cfg.worldsDir` wherever the file currently uses its local variables.

Add `configWarnings: []` to the `buildServer` call.

- [ ] **Step 2: Give every existing call the token**

Every `makeApi(baseUrl)` in this file becomes `makeApi(baseUrl, TOKEN)`. There are roughly 20 of them; change all.

- [ ] **Step 3: Run to verify the existing suite passes with auth on**

Run from `client/`: `npx vitest run test/api.integration.test.ts`
Expected: PASS. A failure here means a call path is not sending the header — which is the bug this task exists to catch. Fix `api.ts`, not the test.

- [ ] **Step 4: Add the rejection cases**

```ts
describe("access token over the real transport", () => {
  it("rejects a GET with no token", async () => {
    await expect(makeApi(baseUrl, "").status()).rejects.toThrow(/token/i);
  });

  it("rejects a GET with the wrong token", async () => {
    await expect(makeApi(baseUrl, "wrong").status()).rejects.toThrow(/token/i);
  });

  it("rejects a bodyless POST with the wrong token", async () => {
    await expect(makeApi(baseUrl, "wrong").stop()).rejects.toThrow(/token/i);
  });

  it("surfaces the rejection as a 401 the client can branch on", async () => {
    await expect(makeApi(baseUrl, "wrong").status()).rejects.toMatchObject({ status: 401 });
  });

  it("rejects the raw-body jar upload with the wrong token", async () => {
    // uploadMod builds its own fetch rather than going through request(), so
    // it is the one call that can be missing the header while every other
    // action works. Asserted here, over a real socket, for that reason.
    await expect(
      makeApi(baseUrl, "wrong").uploadMod(modJarBytes({ id: "x.y", name: "X" }), "x.jar"),
    ).rejects.toThrow(/token/i);
  });

  it("accepts the jar upload with the right token", async () => {
    const r = await makeApi(baseUrl, TOKEN).uploadMod(
      modJarBytes({ id: "x.y", name: "X" }),
      "x.jar",
    );
    expect(r.ok).toBe(true);
  });

  it("rejects the websocket upgrade without a token", async () => {
    const url = `${baseUrl.replace(/^http/, "ws")}/ws`;
    const status = await upgradeStatus(url);
    expect(status).toBe(401);
  });

  it("accepts the websocket upgrade with the token on the query string", async () => {
    const url = `${baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(TOKEN)}`;
    const status = await upgradeStatus(url);
    expect(status).toBe(101);
  });
});
```

Add this helper near the top of the file, below the imports. It uses Node's `http` client directly because the point is to observe the upgrade handshake's status code, which a WebSocket client abstracts away:

```ts
import { request as httpRequest } from "node:http";

/**
 * The HTTP status the daemon answers a WebSocket upgrade with.
 *
 * Driven at the http layer rather than through a WebSocket client because the
 * assertion is about the handshake itself: a client library reports "it did not
 * connect" identically for a 401 and a refused connection, and telling those
 * apart is the whole point of this test.
 */
const upgradeStatus = (wsUrl: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const req = httpRequest({
      host: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 101);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
```

Note: on a successful upgrade Node emits `upgrade`, not `response`, and `res.statusCode` there is 101.

- [ ] **Step 5: Run and verify**

Run from `client/`: `npx vitest run test/api.integration.test.ts`
Expected: PASS, including all 8 new cases.

Then the full client suite and typecheck: `npx vitest run` and `npx tsc --noEmit`.

- [ ] **Step 6: Commit**

```bash
git add client/test/api.integration.test.ts
git commit -m "test: prove the token works across the real client/daemon seam"
```

---

### Task 11: Scrub personal data and parameterize the scripts

**Files:**
- Create: `config.example.json`
- Delete: `scripts/seed/config.json`
- Modify: `scripts/02-deploy.ps1`, `scripts/03-register-task.ps1`, `scripts/04-restart-daemon.ps1`
- Create: `scripts/deploy.local.ps1.example`
- Modify: `.gitignore`
- Modify: `CLAUDE.md`
- Create: `CLAUDE.local.md`

- [ ] **Step 1: Write `config.example.json`**

```json
{
  "port": 8710,
  "dataDir": "C:\\Users\\YOURNAME\\AppData\\Roaming\\Necesse",
  "serverRoot": "C:\\necesseserver",
  "serverJar": "C:\\necesseserver\\Server.jar",
  "javaExe": "C:\\necesseserver\\jre\\bin\\java.exe",
  "steamcmdExe": "C:\\steamcmd\\steamcmd.exe",
  "authToken": "",
  "steamApiKey": "",
  "owners": [],
  "lastWorld": null,
  "stopTimeoutMs": 90000,
  "jvmArgs": [
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+UseG1GC",
    "-XX:+ExplicitGCInvokesConcurrent",
    "-XX:G1NewSizePercent=20",
    "-XX:G1ReservePercent=20",
    "-XX:MaxGCPauseMillis=50",
    "-XX:G1HeapRegionSize=32M"
  ]
}
```

There is deliberately no `modsDir` or `worldsDir`: both are derived from `dataDir`, and a config that carries them is refused. Say so in the README, not in the JSON — JSON has no comments.

- [ ] **Step 2: Delete the seed config and fix its references**

```powershell
Select-String -Path scripts\*.ps1 -Pattern "seed"
```

`02-deploy.ps1` seeds `config.json` and `mods.json` only when absent. With state now in `%PROGRAMDATA%`, seeding `config.json` is the setup wizard's job — remove that from the deploy script and leave `mods.json` alone. Delete `scripts/seed/config.json`; keep `scripts/seed/mods.json`.

- [ ] **Step 3: Create `scripts/deploy.local.ps1.example`**

```powershell
# Copy to deploy.local.ps1 (gitignored) and fill in your own values.
# The deploy scripts dot-source this; nothing here is committed.

$RemoteUser  = "youruser"
$RemoteHost  = "192.168.1.50"
$SshKey      = "$env:USERPROFILE\.ssh\necesse_server"
# Where the daemon's CODE lives on the server. Its state lives in
# %PROGRAMDATA%\NecesseServerManager and is never touched by a deploy.
$InstallDir  = "C:\Users\youruser\necesse-daemon"
$DaemonPort  = 8710
$TaskName    = "necesse-daemon"
```

- [ ] **Step 4: Parameterize the three scripts**

At the top of each of `02-deploy.ps1`, `03-register-task.ps1` and `04-restart-daemon.ps1`, replace the hardcoded values with:

```powershell
$local = Join-Path $PSScriptRoot "deploy.local.ps1"
if (-not (Test-Path $local)) {
  throw "No $local. Copy deploy.local.ps1.example to deploy.local.ps1 and fill in your own values."
}
. $local
$remote = "$RemoteUser@$RemoteHost"
$key    = $SshKey
$dest   = $InstallDir
$destFwd = $InstallDir -replace '\\', '/'
```

Then replace every literal use of the old values (`jeffp@192.168.1.106`, `C:\Users\jeffp\necesse-daemon`, `C:/Users/jeffp/necesse-daemon`, `8710`, `necesse-daemon` as a task name) with the variables. Note `03-register-task.ps1` runs **on the server**, so it reads `deploy.local.ps1` from its own directory there; keep that working by having it fall back to its existing defaults for `$DaemonPort`/`$TaskName` only if the file is absent — but still throw if `$InstallDir` cannot be determined.

Do not run any of these scripts.

- [ ] **Step 5: Extend `.gitignore`**

```
scripts/deploy.local.ps1
CLAUDE.local.md
```

- [ ] **Step 6: Split `CLAUDE.md`**

Move the machine-specific content out of `CLAUDE.md` into a new `CLAUDE.local.md`: the SSH target line, the "Verified live on 2026-07-28" paragraph, the `jeffp`/Microsoft-account explanation, and the specific `C:\Users\jeffp\...` paths. Keep in `CLAUDE.md` everything that is true for any user of the repo, rewritten generically:

- Layout and commands table.
- The deploy warning (the game server is a child of the daemon; check `GET /api/status` first).
- **New:** state lives in `%PROGRAMDATA%\NecesseServerManager`, the install directory is disposable, `config.json` is written by the setup wizard.
- **New:** `dataDir` is the single source of truth; `modsDir`/`worldsDir` are derived and a config carrying them is refused.
- The SYSTEM/`-datadir` explanation, with the account name generalized.
- Every entry under "Constraints that bite" and "Testing" and "World save zips" — all still true.
- **New:** the access token, and that an empty `authToken` means no authentication.

`CLAUDE.local.md` opens with a line saying it is the machine-specific half of `CLAUDE.md` and is gitignored.

- [ ] **Step 7: Verify no personal data remains in tracked source**

```powershell
Select-String -Path daemon\src\*.ts,client\src\*.ts,scripts\*.ps1,*.json,*.md -Pattern "jeffp|192\.168\.1\.106" | Where-Object { $_.Path -notmatch "CLAUDE.local.md" }
```

Expected hits: only `docs/verification-2026-07-27.md` and `docs/superpowers/specs/2026-07-26-*.html`, which are evidence and stay. If `CLAUDE.md` or any `.ts`/`.ps1` appears, it was missed.

- [ ] **Step 8: Run both suites and commit**

Run from `daemon/` and `client/`: `npx vitest run` and `npx tsc --noEmit`.

```bash
git add -A
git commit -m "chore: remove machine-specific values from tracked source"
```

---

### Task 12: README and LICENSE

**Files:**
- Create: `README.md`
- Create: `LICENSE`

- [ ] **Step 1: Write `LICENSE`**

MIT, copyright `2026 Jeff Pegg`.

- [ ] **Step 2: Write `README.md`**

Sections, in this order:

1. **What this is** — a desktop app for managing a Necesse dedicated server on your own LAN: start/stop, per-world mod sets from the Steam Workshop, live console, world settings editing. Two pieces: a daemon on the server box, a client on your PC.
2. **Requirements** — Windows on the server box; a Necesse dedicated server already installed; Node 22+ on the server; steamcmd optional but needed for mod installs and server updates.
3. **Install the daemon** — download `necesse-daemon-vX.Y.Z.zip` from Releases, unzip anywhere, run `setup.cmd`, note the token it prints, run `start-daemon.cmd`.
4. **Run it at boot (optional)** — `register-task.ps1` as Administrator; explain it registers AtStartup as SYSTEM with a 30-second delay, and why `-datadir` makes that safe.
5. **Install the client** — download the installer from Releases, run it. **Note the SmartScreen warning**: the installer is unsigned, so Windows will warn; "More info" then "Run anyway".
6. **Connect** — enter host, port and the token from setup. The Copy button gives you a blob you can paste into a second machine.
7. **Upgrading** — replace the install directory wholesale. State lives in `%PROGRAMDATA%\NecesseServerManager` and is never touched. Users of a pre-1.1 install run `migrate.cmd` once.
8. **Security** — plainly: the daemon spawns processes and writes files on the server. The token stops other devices on your network from driving it, but it is a shared secret over plain HTTP; never port-forward the daemon or expose it to the internet. Setting `authToken` to `""` disables the check, which is only reasonable on a network you fully control.
9. **Configuration reference** — a table of every `config.json` key, and an explicit note that `modsDir`/`worldsDir` are derived from `dataDir` and must not be set.
10. **Building from source** — `npm ci` and `npm run build` in `daemon/`; `npm ci` and `npm run tauri build` in `client/` (needs Rust + MSVC + WebView2). Tests: `npx vitest run` in each.
11. **A note on the CSP** — the client's `connect-src` allows any origin because the daemon's address is entered at runtime. Stated rather than buried.
12. **License** — MIT.

Write plainly. No em dashes, no curly quotes, none of "leverage", "seamlessly", "robust", "comprehensive".

- [ ] **Step 3: Commit**

```bash
git add README.md LICENSE
git commit -m "docs: README and MIT license"
```

---

### Task 13: CI and release workflows

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: ["**"]
  pull_request:

jobs:
  test:
    # Windows, not Ubuntu. This codebase is full of Windows path handling,
    # case-insensitive comparisons and backslash separators; a green Linux run
    # would prove nothing about it.
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install daemon deps
        run: npm ci
        working-directory: daemon
      - name: Install client deps
        run: npm ci
        working-directory: client
      - name: Typecheck daemon
        run: npx tsc --noEmit
        working-directory: daemon
      - name: Typecheck client
        run: npx tsc --noEmit
        working-directory: client
      - name: Test daemon
        run: npx vitest run
        working-directory: daemon
      - name: Test client
        run: npx vitest run
        working-directory: client
      - name: Shared types are byte-identical
        shell: pwsh
        run: |
          $a = (Get-FileHash daemon/src/types.ts -Algorithm SHA256).Hash
          $b = (Get-FileHash client/src/types.ts -Algorithm SHA256).Hash
          if ($a -ne $b) { throw "daemon/src/types.ts and client/src/types.ts have diverged" }
```

- [ ] **Step 2: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  release:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: dtolnay/rust-toolchain@stable

      - name: Build daemon
        working-directory: daemon
        run: |
          npm ci
          npm run build

      - name: Stage the daemon zip
        shell: pwsh
        run: |
          $stage = "staging/necesse-daemon"
          New-Item -ItemType Directory -Force -Path $stage | Out-Null
          Copy-Item -Recurse daemon/dist "$stage/dist"
          Copy-Item daemon/package.json,daemon/package-lock.json $stage
          Copy-Item daemon/setup.cmd,daemon/start-daemon.cmd,daemon/migrate.cmd $stage
          Copy-Item scripts/03-register-task.ps1 "$stage/register-task.ps1"
          Copy-Item config.example.json $stage
          Push-Location $stage
          npm ci --omit=dev
          Pop-Location
          Compress-Archive -Path "$stage/*" -DestinationPath "necesse-daemon-${{ github.ref_name }}.zip"

      - name: Build client
        working-directory: client
        run: |
          npm ci
          npm run tauri build

      - name: Publish release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            necesse-daemon-${{ github.ref_name }}.zip
            client/src-tauri/target/release/bundle/nsis/*.exe
            client/src-tauri/target/release/bundle/msi/*.msi
          body: |
            The installer is unsigned, so Windows SmartScreen will warn on first run.
            Choose "More info" then "Run anyway".

            Upgrading from an install that kept its state beside dist/: run migrate.cmd once.
```

- [ ] **Step 3: Validate the YAML parses**

```powershell
python -c "import yaml,sys;[yaml.safe_load(open(p,encoding='utf-8')) for p in ['.github/workflows/ci.yml','.github/workflows/release.yml']];print('ok')"
```

If PyYAML is absent, skip this step and note it — do not install packages. These workflows cannot be exercised locally; that limitation is real and goes in the final report rather than being papered over.

- [ ] **Step 4: Commit**

```bash
git add .github
git commit -m "ci: test on windows-latest and publish release artifacts on a tag"
```

---

### Task 14: Final verification

- [ ] **Step 1: Both suites, both typechecks, from a clean state**

Run from `daemon/`: `npx vitest run; "EXIT=$LASTEXITCODE"` then `npx tsc --noEmit; "EXIT=$LASTEXITCODE"`
Run from `client/`: `npx vitest run; "EXIT=$LASTEXITCODE"` then `npx tsc --noEmit; "EXIT=$LASTEXITCODE"`
Expected: `EXIT=0` four times.

- [ ] **Step 2: Shared types are byte-identical**

```powershell
$a = (Get-FileHash daemon\src\types.ts -Algorithm SHA256).Hash
$b = (Get-FileHash client\src\types.ts -Algorithm SHA256).Hash
"MATCH=$($a -eq $b)"
```
Expected: `MATCH=True`.

- [ ] **Step 3: No personal values in tracked source**

```powershell
git ls-files | Where-Object { $_ -notmatch "^docs/" } | ForEach-Object { Select-String -Path $_ -Pattern "jeffp|192\.168\.1\.106" -ErrorAction SilentlyContinue }
```
Expected: no output.

- [ ] **Step 4: The daemon build produces the entry points the release zip expects**

Run from `daemon/`: `npm run build`
Then confirm `dist/index.js`, `dist/setup-cli.js` and `dist/migrate-cli.js` all exist.

- [ ] **Step 5: Report**

Write `docs/verification-2026-07-29.md` recording what was run, what passed, and — explicitly — what was **not** exercised: no deploy to SERVER, no Tauri build, no GitHub Actions run, and the setup wizard's interactive path never driven end to end (only its pure probe function is tested). Name those gaps rather than letting four green suites imply coverage they do not have.

- [ ] **Step 6: Commit**

```bash
git add docs/verification-2026-07-29.md
git commit -m "docs: verification record for the shareable release work"
```

---

## Self-Review

**Spec coverage:** §3 config model → Tasks 1, 2. §4 setup wizard → Task 6. §5 boot validation → Tasks 2, 5. §6 authentication → Tasks 4, 10. §7 client → Tasks 7, 8, 9. §8 packaging → Tasks 11, 12, 13, plus the state directory in Tasks 1 and 3. §9 error handling → distributed, and pinned by tests in Tasks 2, 3, 9. §10 testing → every task, with Task 10 the seam. §11 migration → Task 3 plus the README in Task 12. §12 out of scope → nothing implemented.

**Known gaps, stated rather than hidden:** the release workflow cannot be run locally; the Tauri build is not exercised; the setup wizard's interactive prompting is not tested end to end, only its pure probe. All three go in the Task 14 report.
