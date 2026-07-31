# Per-World Launch Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each world carry its own server launch options (owner, slots, MOTD, password and the rest of `Server.jar`'s command line), edited from the client, falling back to daemon-wide defaults.

**Architecture:** A schema module defines every exposed option with the game's own constraints; a store mirrors `mod-sets.ts` to keep defaults plus per-world overrides in `launch-options.json`; `buildArgs` becomes a function of the merged result. The daemon's own arguments (`-nogui`, `-datadir`, `-world`) are deliberately absent from the schema so they cannot be overridden.

**Tech Stack:** Node 22 + TypeScript (ESM, NodeNext) + Fastify 5 + vitest on the daemon. React 19 + Vite + Tauri 2 + vitest/RTL on the client.

**Spec:** `docs/superpowers/specs/2026-07-31-launch-options-design.html`

## Global Constraints

- **Work on branch `feat/launch-options`.** Never commit to `main`.
- **`daemon/src/types.ts` and `client/src/types.ts` must stay byte-identical.** Any task editing one edits the other in the same commit. Task 8 verifies by hash.
- **Daemon sources must stay ES2020-library-compatible.** `daemon/tsconfig.json` pins `"lib": ["ES2020"]` because `client/test/api.integration.test.ts` typechecks every daemon file again under the client's lib. No `Object.hasOwn`, `Array.prototype.at`, `findLast`. Do not raise the lib.
- **`-nogui`, `-datadir` and `-world` are daemon-controlled and must never be settable through the schema, the store, or an API payload.** `-datadir` in particular is what lets the daemon run as SYSTEM and still find the real worlds and mods; a user-supplied value produces a server that starts cleanly with zero worlds and reports success.
- **Values are validated in the daemon at save time**, against the game's own bounds. The game clamps silently, so forwarding an out-of-range value means the UI and the running server disagree with no error anywhere.
- **Errors are never swallowed or reworded.** `ENOENT` is distinguished from a real failure; everything else rethrows with the path and the underlying message. A `catch` returning a default is a defect here.
- **No comments that restate the code.** Comment only a non-obvious *why*. `mod-sets.ts` and `world-settings-schema.ts` are the standard to match.
- **Verify with the real tooling:** from `daemon/` `npx vitest run` and `npx tsc --noEmit`; from `client/` the same. All four, every task.
- **Never run anything under `scripts/`** and never deploy. **Foreground only** — no backgrounding, no Monitor tool.
- Windows. Read/Edit/Write/Glob/Grep with native Windows paths; PowerShell tool for commands; Bash only for `git`.

---

### Task 1: Schema and validation

**Files:**
- Create: `daemon/src/launch-options-schema.ts`
- Modify: `daemon/src/types.ts` and `client/src/types.ts` (identical edits)
- Test: `daemon/test/launch-options-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LaunchOptionValue = string | number | boolean` (in types.ts)
  - `LaunchOptionField { name, type, group, label, help, min?, max? }` (in types.ts)
  - `LAUNCH_OPTION_FIELDS: readonly LaunchOptionField[]`
  - `fieldByName(name: string): LaunchOptionField | undefined`
  - `checkLaunchOption(name: string, value: unknown): string | null` — why it is invalid, or null
  - `effectiveOptions(defaults, overrides): Record<string, LaunchOptionValue>`

- [ ] **Step 1: Add the shared types**

In **both** `daemon/src/types.ts` and `client/src/types.ts`, append:

```ts
/** A launch option's value. The game takes strings; these are the typed forms. */
export type LaunchOptionValue = string | number | boolean;

export type LaunchOptionType = "string" | "int" | "boolean";

export type LaunchOptionGroup = "identity" | "capacity" | "behaviour" | "world";

/**
 * One option the server accepts on its command line, as this daemon exposes it.
 *
 * `name` is the flag without its leading dash, which is also the key used in
 * launch-options.json. The daemon's own arguments (nogui, datadir, world) are
 * deliberately absent from the field list: they are not settable, and their
 * absence here is what enforces that.
 */
export interface LaunchOptionField {
  name: string;
  type: LaunchOptionType;
  group: LaunchOptionGroup;
  label: string;
  help: string;
  /** int only, inclusive, mirroring the game's own clamp. */
  min?: number;
  max?: number;
}

export interface LaunchOptionsResponse {
  ok: true;
  /** Absent for the daemon-wide defaults. */
  world: string | null;
  effective: Record<string, LaunchOptionValue>;
  overrides: Record<string, LaunchOptionValue>;
  defaults: Record<string, LaunchOptionValue>;
  fields: LaunchOptionField[];
}
```

- [ ] **Step 2: Verify the two type files are byte-identical**

```powershell
$a = (Get-FileHash daemon\src\types.ts -Algorithm SHA256).Hash
$b = (Get-FileHash client\src\types.ts -Algorithm SHA256).Hash
"MATCH=$($a -eq $b)"
```
Expected: `MATCH=True`.

- [ ] **Step 3: Write the failing tests**

Create `daemon/test/launch-options-schema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  LAUNCH_OPTION_FIELDS,
  checkLaunchOption,
  effectiveOptions,
  fieldByName,
} from "../src/launch-options-schema.js";

describe("LAUNCH_OPTION_FIELDS", () => {
  it("never exposes an argument the daemon controls", () => {
    // -datadir is what lets the daemon run as SYSTEM and still find the real
    // worlds and mods. A settable one produces a server that starts cleanly
    // against an empty directory and reports success.
    const names = LAUNCH_OPTION_FIELDS.map((f) => f.name);
    for (const forbidden of ["datadir", "world", "nogui", "settings", "logs"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("exposes the options read from ServerLoader", () => {
    const names = LAUNCH_OPTION_FIELDS.map((f) => f.name).sort();
    expect(names).toEqual(
      [
        "ip", "itemslife", "language", "logging", "maxsettlements", "maxsettlers",
        "motd", "owner", "password", "pausewhenempty", "port", "slots",
        "strictserverauthority", "unloadlevels", "unloadsettlements",
        "worldborder", "zipsaves",
      ].sort(),
    );
  });

  it("gives every field a label and help text", () => {
    for (const f of LAUNCH_OPTION_FIELDS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.help.length).toBeGreaterThan(0);
    }
  });
});

describe("checkLaunchOption", () => {
  it("rejects an unknown option by name", () => {
    expect(checkLaunchOption("nosuchthing", "x")).toMatch(/not a known/i);
  });

  it("accepts a valid value for each type", () => {
    expect(checkLaunchOption("owner", "Jeff")).toBeNull();
    expect(checkLaunchOption("slots", 5)).toBeNull();
    expect(checkLaunchOption("pausewhenempty", true)).toBeNull();
  });

  it("rejects a wrong type, naming what it wanted", () => {
    expect(checkLaunchOption("slots", "five")).toMatch(/whole number/i);
    expect(checkLaunchOption("pausewhenempty", "yes")).toMatch(/true or false/i);
    expect(checkLaunchOption("owner", 7)).toMatch(/text/i);
  });

  it("rejects a non-integer where the game parses an int", () => {
    expect(checkLaunchOption("slots", 5.5)).toMatch(/whole number/i);
  });

  // The game clamps rather than refusing, so an out-of-range value would
  // silently become a different one. These bounds are the game's own.
  it("refuses values outside the game's clamp, naming the limit", () => {
    expect(checkLaunchOption("slots", 0)).toMatch(/1 and 250/);
    expect(checkLaunchOption("slots", 251)).toMatch(/1 and 250/);
    expect(checkLaunchOption("port", -1)).toMatch(/0 and 65535/);
    expect(checkLaunchOption("port", 65536)).toMatch(/0 and 65535/);
    expect(checkLaunchOption("unloadlevels", 1)).toMatch(/2 or more/);
    expect(checkLaunchOption("worldborder", -2)).toMatch(/-1 or more/);
    expect(checkLaunchOption("itemslife", -1)).toMatch(/0 or more/);
    expect(checkLaunchOption("maxsettlements", -2)).toMatch(/-1 or more/);
    expect(checkLaunchOption("maxsettlers", -2)).toMatch(/-1 or more/);
  });

  it("accepts the exact edges", () => {
    expect(checkLaunchOption("slots", 1)).toBeNull();
    expect(checkLaunchOption("slots", 250)).toBeNull();
    expect(checkLaunchOption("port", 0)).toBeNull();
    expect(checkLaunchOption("port", 65535)).toBeNull();
    expect(checkLaunchOption("unloadlevels", 2)).toBeNull();
    expect(checkLaunchOption("worldborder", -1)).toBeNull();
    expect(checkLaunchOption("itemslife", 0)).toBeNull();
  });
});

describe("fieldByName", () => {
  it("finds a field and reports an unknown one as undefined", () => {
    expect(fieldByName("slots")?.type).toBe("int");
    expect(fieldByName("datadir")).toBeUndefined();
  });
});

describe("effectiveOptions", () => {
  it("returns defaults when a world overrides nothing", () => {
    expect(effectiveOptions({ owner: "Jeff", slots: 5 }, {})).toEqual({ owner: "Jeff", slots: 5 });
  });

  it("lets a world override a default", () => {
    expect(effectiveOptions({ owner: "Jeff" }, { owner: "Eli" })).toEqual({ owner: "Eli" });
  });

  it("keeps a world-only option that has no default", () => {
    expect(effectiveOptions({}, { motd: "hello" })).toEqual({ motd: "hello" });
  });

  it("does not invent values for options set in neither", () => {
    // Unset means the flag is not passed at all, so the game applies its own
    // default rather than this daemon guessing at one.
    expect(effectiveOptions({}, {})).toEqual({});
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run from `daemon/`: `npx vitest run test/launch-options-schema.test.ts`
Expected: FAIL — cannot resolve `../src/launch-options-schema.js`.

- [ ] **Step 5: Write `daemon/src/launch-options-schema.ts`**

```ts
import type { LaunchOptionField, LaunchOptionValue } from "./types.js";

/**
 * The server launch options this daemon exposes, and the game's own limits.
 *
 * Read out of the decompiled `necesse.engine.loading.ServerLoader`
 * (`handleLaunchArgs`, plus the `owner` read in `loadGame`), not from
 * documentation. Two properties of that source shape everything here: the game
 * CLAMPS rather than rejecting, and an unparseable integer only warns and keeps
 * the default - so a wrong value never fails a launch, it quietly becomes a
 * different value. That is why `checkLaunchOption` refuses instead of passing
 * things through.
 *
 * `nogui`, `datadir` and `world` are absent on purpose. They are the daemon's
 * own arguments, and their absence from this list is the whole mechanism that
 * stops them being overridden. `settings` and `logs` are absent too: the first
 * would create a second source of truth these options then override, and the
 * second moves a log directory the daemon does not read from anyway.
 */
const str = (
  name: string,
  group: LaunchOptionField["group"],
  label: string,
  help: string,
): LaunchOptionField => ({ name, type: "string", group, label, help });

const bool = (
  name: string,
  group: LaunchOptionField["group"],
  label: string,
  help: string,
): LaunchOptionField => ({ name, type: "boolean", group, label, help });

const int = (
  name: string,
  group: LaunchOptionField["group"],
  label: string,
  help: string,
  min: number,
  max?: number,
): LaunchOptionField => ({ name, type: "int", group, label, help, min, max });

export const LAUNCH_OPTION_FIELDS: readonly LaunchOptionField[] = [
  str("owner", "identity", "Owner", "Any player connecting with this name gets owner permissions. The game supports exactly one."),
  str("motd", "identity", "Message of the day", "Shown to players on connect. \\n becomes a line break."),
  str("password", "identity", "Password", "Players must enter this to join. Leave unset for an open server."),

  int("slots", "capacity", "Player slots", "How many players may be connected at once.", 1, 250),
  int("port", "capacity", "Game port", "The port PLAYERS connect to, not the daemon's. Changing it needs a matching firewall rule or nobody can reach the server.", 0, 65535),
  str("ip", "capacity", "Bind address", "Which local address the server binds to. Leave unset to bind all of them."),

  bool("pausewhenempty", "behaviour", "Pause when empty", "Stops the world ticking while no players are connected."),
  bool("strictserverauthority", "behaviour", "Strict server authority", "The server decides player positions rather than trusting the client."),
  bool("logging", "behaviour", "Server logging", "Writes the server log to disk."),
  bool("zipsaves", "behaviour", "Zip saves", "Stores world saves as zip files."),

  int("worldborder", "world", "World border", "Size of the world border. -1 for none.", -1),
  int("itemslife", "world", "Dropped item lifetime", "Minutes a dropped item survives before despawning. 0 for forever.", 0),
  int("unloadlevels", "world", "Unload levels after", "Seconds before an empty level is unloaded from memory.", 2),
  bool("unloadsettlements", "world", "Unload settlements", "Lets settlements unload with their level."),
  int("maxsettlements", "world", "Max settlements per player", "-1 for unlimited.", -1),
  int("maxsettlers", "world", "Max settlers per settlement", "-1 for unlimited.", -1),
  str("language", "world", "Language", "Server language id. An unknown value falls back to the default with a warning."),
];

const BY_NAME: ReadonlyMap<string, LaunchOptionField> = new Map(
  LAUNCH_OPTION_FIELDS.map((f) => [f.name, f]),
);

export function fieldByName(name: string): LaunchOptionField | undefined {
  return BY_NAME.get(name);
}

/**
 * Why this value cannot be stored for this option, or null if it can.
 *
 * An unknown name is refused rather than ignored: silently dropping a key means
 * a user sets something, sees no error, and gets a server that does not have
 * it. This is also the gate that keeps `datadir` and friends out, since they
 * are not in the field list.
 */
export function checkLaunchOption(name: string, value: unknown): string | null {
  const field = fieldByName(name);
  if (field === undefined) {
    return `"${name}" is not a known launch option.`;
  }
  if (field.type === "string") {
    if (typeof value !== "string") return `"${name}" takes text.`;
    return null;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") return `"${name}" takes true or false.`;
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return `"${name}" takes a whole number.`;
  }
  const { min, max } = field;
  if (min !== undefined && max !== undefined && (value < min || value > max)) {
    // Named limits, because the game silently clamps to them rather than
    // reporting anything: without this the UI and the running server disagree.
    return `"${name}" must be between ${min} and ${max}; the game clamps anything outside that.`;
  }
  if (min !== undefined && max === undefined && value < min) {
    return `"${name}" must be ${min} or more; the game clamps anything lower.`;
  }
  return null;
}

/** Daemon-wide defaults with a world's overrides applied on top. */
export function effectiveOptions(
  defaults: Record<string, LaunchOptionValue>,
  overrides: Record<string, LaunchOptionValue>,
): Record<string, LaunchOptionValue> {
  return { ...defaults, ...overrides };
}
```

- [ ] **Step 6: Run to verify it passes**

Run from `daemon/`: `npx vitest run test/launch-options-schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck both packages**

From `daemon/`: `npx tsc --noEmit`. From `client/`: `npx tsc --noEmit`. Both clean.

- [ ] **Step 8: Commit**

```bash
git add daemon/src/launch-options-schema.ts daemon/src/types.ts client/src/types.ts daemon/test/launch-options-schema.test.ts
git commit -m "feat(daemon): schema and validation for server launch options"
```

---

### Task 2: The store

**Files:**
- Create: `daemon/src/launch-options.ts`
- Test: `daemon/test/launch-options.test.ts`

**Interfaces:**
- Consumes: `LaunchOptionValue` (Task 1), `normaliseWorld` from `./mod-sets.js`, `writeJsonDurable` from `./durable-write.js`.
- Produces: class `LaunchOptions` with
  - `load(): Promise<LaunchOptionsFile>`
  - `defaults(): Promise<Record<string, LaunchOptionValue>>`
  - `forWorld(world: string): Promise<Record<string, LaunchOptionValue>>` — that world's overrides only
  - `effectiveFor(world: string): Promise<Record<string, LaunchOptionValue>>`
  - `setDefaults(changes: Record<string, LaunchOptionValue | null>): Promise<Record<string, LaunchOptionValue>>`
  - `setForWorld(world: string, changes: Record<string, LaunchOptionValue | null>): Promise<Record<string, LaunchOptionValue>>`
  - exported `interface LaunchOptionsFile { defaults; worlds; updatedAt }`

- [ ] **Step 1: Write the failing tests**

Create `daemon/test/launch-options.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchOptions } from "../src/launch-options.js";

let root: string;
let file: string;
let store: LaunchOptions;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-launch-"));
  file = join(root, "launch-options.json");
  store = new LaunchOptions(file);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("load", () => {
  it("treats a missing file as empty rather than an error", async () => {
    expect(await store.load()).toEqual({ defaults: {}, worlds: {}, updatedAt: null });
  });

  it("reports a parse failure with the path rather than defaulting", async () => {
    await writeFile(file, "{ not json", "utf8");
    await expect(store.load()).rejects.toThrow(file);
  });
});

describe("setDefaults", () => {
  it("stores and reads back", async () => {
    await store.setDefaults({ owner: "Jeff", slots: 5 });
    expect(await store.defaults()).toEqual({ owner: "Jeff", slots: 5 });
  });

  it("merges rather than replacing", async () => {
    await store.setDefaults({ owner: "Jeff" });
    await store.setDefaults({ slots: 5 });
    expect(await store.defaults()).toEqual({ owner: "Jeff", slots: 5 });
  });

  it("clears an option when given null", async () => {
    await store.setDefaults({ owner: "Jeff", slots: 5 });
    await store.setDefaults({ slots: null });
    expect(await store.defaults()).toEqual({ owner: "Jeff" });
  });
});

describe("setForWorld", () => {
  it("keeps worlds separate", async () => {
    await store.setForWorld("Tulsa", { motd: "tulsa" });
    await store.setForWorld("Goober Goof", { motd: "goober" });
    expect(await store.forWorld("Tulsa")).toEqual({ motd: "tulsa" });
    expect(await store.forWorld("Goober Goof")).toEqual({ motd: "goober" });
  });

  // Windows filenames are case-insensitive and listWorlds reads names off disk,
  // so two casings are one world everywhere else in this daemon.
  it("treats a world name case-insensitively", async () => {
    await store.setForWorld("Tulsa", { motd: "tulsa" });
    expect(await store.forWorld("TULSA")).toEqual({ motd: "tulsa" });
    await store.setForWorld("  tulsa  ", { slots: 3 });
    expect(await store.forWorld("Tulsa")).toEqual({ motd: "tulsa", slots: 3 });
  });

  it("clears a world override when given null, falling back to the default", async () => {
    await store.setDefaults({ slots: 5 });
    await store.setForWorld("Tulsa", { slots: 20 });
    expect(await store.effectiveFor("Tulsa")).toEqual({ slots: 20 });
    await store.setForWorld("Tulsa", { slots: null });
    expect(await store.forWorld("Tulsa")).toEqual({});
    expect(await store.effectiveFor("Tulsa")).toEqual({ slots: 5 });
  });
});

describe("effectiveFor", () => {
  it("is the defaults for a world with no overrides", async () => {
    await store.setDefaults({ owner: "Jeff" });
    expect(await store.effectiveFor("Anything")).toEqual({ owner: "Jeff" });
  });

  it("lets a world override one option without losing the others", async () => {
    await store.setDefaults({ owner: "Jeff", slots: 5 });
    await store.setForWorld("Tulsa", { owner: "Eli" });
    expect(await store.effectiveFor("Tulsa")).toEqual({ owner: "Eli", slots: 5 });
  });
});

describe("persistence", () => {
  it("writes a file a second store can read", async () => {
    await store.setDefaults({ owner: "Jeff" });
    await store.setForWorld("Tulsa", { slots: 9 });
    const reopened = new LaunchOptions(file);
    expect(await reopened.defaults()).toEqual({ owner: "Jeff" });
    expect(await reopened.forWorld("Tulsa")).toEqual({ slots: 9 });
  });

  it("records when it last changed", async () => {
    await store.setDefaults({ owner: "Jeff" });
    const written = JSON.parse(await readFile(file, "utf8")) as { updatedAt: string };
    expect(Date.parse(written.updatedAt)).not.toBeNaN();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `daemon/`: `npx vitest run test/launch-options.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `daemon/src/launch-options.ts`**

```ts
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeJsonDurable } from "./durable-write.js";
import { normaliseWorld } from "./mod-sets.js";
import type { LaunchOptionValue } from "./types.js";

export interface LaunchOptionsFile {
  defaults: Record<string, LaunchOptionValue>;
  /** Keyed by normalised world name, exactly as mod sets are. */
  worlds: Record<string, Record<string, LaunchOptionValue>>;
  updatedAt: string | null;
}

const EMPTY: LaunchOptionsFile = { defaults: {}, worlds: {}, updatedAt: null };

/**
 * Daemon-wide launch option defaults, plus each world's overrides.
 *
 * World keys are normalised the same way mod sets are, and for the same reason:
 * Windows filenames are case-insensitive and world names are read off disk, so
 * `tulsa` and `Tulsa` are one world everywhere else in this daemon. A set of
 * overrides filed under the wrong case is a set that silently never applies,
 * and the first anyone would know of it is a start with the wrong options.
 */
export class LaunchOptions {
  constructor(private file: string) {}

  async load(): Promise<LaunchOptionsFile> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Failed to read launch options at ${this.file}: ${(e as Error).message}`);
      }
      return { ...EMPTY };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LaunchOptionsFile>;
      return {
        defaults: parsed.defaults ?? {},
        worlds: parsed.worlds ?? {},
        updatedAt: parsed.updatedAt ?? null,
      };
    } catch (e) {
      throw new Error(`Failed to parse launch options at ${this.file}: ${(e as Error).message}`);
    }
  }

  async defaults(): Promise<Record<string, LaunchOptionValue>> {
    return (await this.load()).defaults;
  }

  async forWorld(world: string): Promise<Record<string, LaunchOptionValue>> {
    return (await this.load()).worlds[normaliseWorld(world)] ?? {};
  }

  async effectiveFor(world: string): Promise<Record<string, LaunchOptionValue>> {
    const all = await this.load();
    return { ...all.defaults, ...(all.worlds[normaliseWorld(world)] ?? {}) };
  }

  async setDefaults(
    changes: Record<string, LaunchOptionValue | null>,
  ): Promise<Record<string, LaunchOptionValue>> {
    const all = await this.load();
    all.defaults = applyChanges(all.defaults, changes);
    await this.write(all);
    return all.defaults;
  }

  async setForWorld(
    world: string,
    changes: Record<string, LaunchOptionValue | null>,
  ): Promise<Record<string, LaunchOptionValue>> {
    const all = await this.load();
    const key = normaliseWorld(world);
    all.worlds[key] = applyChanges(all.worlds[key] ?? {}, changes);
    await this.write(all);
    return all.worlds[key];
  }

  private async write(all: LaunchOptionsFile): Promise<void> {
    all.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.file), { recursive: true });
    // Atomic, for the same reason the mod sets are: a file truncated by a crash
    // mid-write makes every later load throw, and every start then refuses.
    await writeJsonDurable(this.file, all);
  }
}

/** A null clears the option so it falls through to the layer below. */
function applyChanges(
  current: Record<string, LaunchOptionValue>,
  changes: Record<string, LaunchOptionValue | null>,
): Record<string, LaunchOptionValue> {
  const next = { ...current };
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) delete next[name];
    else next[name] = value;
  }
  return next;
}
```

- [ ] **Step 4: Run to verify it passes**

Run from `daemon/`: `npx vitest run test/launch-options.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite and typecheck**

From `daemon/`: `npx vitest run` then `npx tsc --noEmit`. From `client/`: same. All clean.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/launch-options.ts daemon/test/launch-options.test.ts
git commit -m "feat(daemon): store per-world launch options with daemon-wide defaults"
```

---

### Task 3: `buildArgs` takes the effective options

**Files:**
- Modify: `daemon/src/process-manager.ts` — `buildArgs` (currently around lines 112-125) and `start`
- Test: `daemon/test/process-manager.test.ts` (append)

**Interfaces:**
- Consumes: `LaunchOptionValue` (Task 1).
- Produces:
  - `buildArgs(world: string, options: Record<string, LaunchOptionValue>): string[]`
  - `start(world: string, options: Record<string, LaunchOptionValue>): void` — the caller supplies the merged options.

- [ ] **Step 1: Write the failing tests**

Append to `daemon/test/process-manager.test.ts`. Use whatever helper that file already has for constructing a `ProcessManager`; do not introduce a second one.

```ts
describe("buildArgs", () => {
  it("passes the daemon's own arguments", () => {
    const args = pm.buildArgs("Tulsa", {});
    expect(args).toContain("-nogui");
    expect(args[args.indexOf("-datadir") + 1]).toBe(cfg.dataDir);
    expect(args[args.indexOf("-world") + 1]).toBe("Tulsa");
  });

  it("omits an option that is not set rather than passing it empty", () => {
    const args = pm.buildArgs("Tulsa", {});
    expect(args).not.toContain("-owner");
    expect(args).not.toContain("-slots");
    expect(args).not.toContain("-motd");
  });

  it("emits set options as flag and value", () => {
    const args = pm.buildArgs("Tulsa", { owner: "Jeff", slots: 5, motd: "hi" });
    expect(args[args.indexOf("-owner") + 1]).toBe("Jeff");
    expect(args[args.indexOf("-slots") + 1]).toBe("5");
    expect(args[args.indexOf("-motd") + 1]).toBe("hi");
  });

  it("emits booleans as true and false", () => {
    const on = pm.buildArgs("Tulsa", { pausewhenempty: true });
    expect(on[on.indexOf("-pausewhenempty") + 1]).toBe("true");
    const off = pm.buildArgs("Tulsa", { pausewhenempty: false });
    expect(off[off.indexOf("-pausewhenempty") + 1]).toBe("false");
  });

  it("emits each flag at most once", () => {
    // parseLaunchOptions in the game is a HashMap: a repeated flag silently
    // overwrites. Emitting from a record makes a duplicate impossible, and this
    // pins it, because a duplicate is exactly how the owner bug happened.
    const args = pm.buildArgs("Tulsa", { owner: "Jeff", slots: 5 });
    for (const flag of args.filter((a) => a.startsWith("-"))) {
      expect(args.filter((a) => a === flag)).toHaveLength(1);
    }
  });

  it("cannot be made to override the daemon's own arguments", () => {
    // The schema does not expose these, so this can only arrive from a bug or a
    // hand-edited launch-options.json. A user-supplied -datadir produces a
    // server that starts cleanly with zero worlds and reports success.
    const args = pm.buildArgs("Tulsa", {
      datadir: "C:\\evil",
      world: "SomeOtherWorld",
      nogui: "no",
    } as never);
    expect(args[args.indexOf("-datadir") + 1]).toBe(cfg.dataDir);
    expect(args[args.indexOf("-world") + 1]).toBe("Tulsa");
    expect(args.filter((a) => a === "-datadir")).toHaveLength(1);
    expect(args.filter((a) => a === "-world")).toHaveLength(1);
    expect(args).not.toContain("C:\\evil");
    expect(args).not.toContain("SomeOtherWorld");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `daemon/`: `npx vitest run test/process-manager.test.ts`
Expected: FAIL — `buildArgs` takes one argument.

- [ ] **Step 3: Rewrite `buildArgs` and `start`**

Replace the existing `buildArgs` with:

```ts
  /**
   * The full command line for a launch.
   *
   * `-nogui`, `-datadir` and `-world` are the daemon's own. Two things keep
   * them that way, deliberately: the loop skips any supplied entry with one of
   * those names, and they are written LAST so that even if the filter were
   * removed the game's parser - which keeps the last occurrence of a repeated
   * flag - would still resolve to the daemon's value. -datadir is the one that
   * matters most: without the right value the game derives its saves and mods
   * from the running account, and as SYSTEM that is a profile folder holding
   * neither, which the server reports as a completely successful start.
   *
   * Booleans stringify to "true"/"false", which is correct for every boolean
   * option including zipsaves and unloadsettlements - those treat anything that
   * is not "1" or "true" as false.
   */
  buildArgs(world: string, options: Record<string, LaunchOptionValue>): string[] {
    const supplied: string[] = [];
    for (const [name, value] of Object.entries(options)) {
      if (DAEMON_OWNED_ARGS.has(name)) continue;
      supplied.push(`-${name}`, String(value));
    }
    return [
      ...this.cfg.jvmArgs,
      "-jar",
      this.cfg.serverJar,
      ...supplied,
      "-nogui",
      "-datadir",
      this.cfg.dataDir,
      "-world",
      world,
    ];
  }
```

Add near the top of the file, outside the class:

```ts
/**
 * Arguments this daemon owns. Never emitted from caller-supplied options, even
 * if something manages to put one there: the schema does not expose them, so
 * their presence would mean a bug or a hand-edited file.
 */
const DAEMON_OWNED_ARGS: ReadonlySet<string> = new Set(["nogui", "datadir", "world"]);
```

Change `start` to take and forward the options:

```ts
  start(world: string, options: Record<string, LaunchOptionValue>): void {
```

and its spawn line to `this.buildArgs(world, options)`.

Import the type: add `LaunchOptionValue` to the existing `import type { ... } from "./types.js";`.

- [ ] **Step 4: Fix every `start(` and `buildArgs(` call site**

```powershell
Select-String -Path daemon\src\*.ts,daemon\test\*.ts,client\test\*.ts -Pattern "\.start\(|buildArgs\("
```

`daemon/src/http.ts`'s start route is the production one; pass `{}` there for now — Task 5 replaces it with the real merged options. Tests that call `start` get `{}` too.

- [ ] **Step 5: Run to verify it passes**

Run from `daemon/`: `npx vitest run` then `npx tsc --noEmit`. From `client/`: same.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/process-manager.ts daemon/src/http.ts daemon/test/process-manager.test.ts
git commit -m "feat(daemon): build the server command line from per-world launch options"
```

---

### Task 4: Migration and wiring

**Files:**
- Modify: `daemon/src/index.ts` — construct the store, run the migration
- Modify: `daemon/src/config.ts` — retire `owners` from `DEFAULT_CONFIG`
- Modify: `daemon/src/types.ts` and `client/src/types.ts` — drop `owners` from `DaemonConfig`
- Modify: `daemon/src/http.ts` — drop `owners` from `ALLOWED_CONFIG_KEYS`
- Create: `daemon/src/launch-options-migration.ts`
- Test: `daemon/test/launch-options-migration.test.ts`

**Interfaces:**
- Consumes: `LaunchOptions` (Task 2).
- Produces: `migrateOwners(storedOwners: unknown, store: LaunchOptions): Promise<string | null>` — returns a message describing what it did, or null if there was nothing to do.

- [ ] **Step 1: Write the failing tests**

Create `daemon/test/launch-options-migration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchOptions } from "../src/launch-options.js";
import { migrateOwners } from "../src/launch-options-migration.js";

let root: string;
let store: LaunchOptions;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-ownermig-"));
  store = new LaunchOptions(join(root, "launch-options.json"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("migrateOwners", () => {
  it("seeds the default owner from the FIRST entry", async () => {
    // The game keeps the LAST -owner, so this server has been applying Eli.
    // Seeding the first is a deliberate behaviour change: it is the fix this
    // feature exists to deliver, chosen rather than inherited.
    const msg = await migrateOwners(["Jeff", "Eli"], store);
    expect(await store.defaults()).toEqual({ owner: "Jeff" });
    expect(msg).toContain("Jeff");
    expect(msg).toContain("Eli");
  });

  it("creates no per-world overrides", async () => {
    await migrateOwners(["Jeff", "Eli"], store);
    expect(await store.forWorld("Tulsa")).toEqual({});
  });

  it("does nothing when a default owner is already set", async () => {
    await store.setDefaults({ owner: "Someone" });
    expect(await migrateOwners(["Jeff"], store)).toBeNull();
    expect(await store.defaults()).toEqual({ owner: "Someone" });
  });

  it("does nothing for an absent or empty list", async () => {
    expect(await migrateOwners(undefined, store)).toBeNull();
    expect(await migrateOwners([], store)).toBeNull();
    expect(await store.defaults()).toEqual({});
  });

  it("ignores a stored value that is not a list of names", async () => {
    expect(await migrateOwners("Jeff", store)).toBeNull();
    expect(await migrateOwners([1, 2], store)).toBeNull();
    expect(await store.defaults()).toEqual({});
  });

  it("says nothing about a collapse when there was only one owner", async () => {
    const msg = await migrateOwners(["Jeff"], store);
    expect(await store.defaults()).toEqual({ owner: "Jeff" });
    expect(msg).not.toMatch(/only the last/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `daemon/`: `npx vitest run test/launch-options-migration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `daemon/src/launch-options-migration.ts`**

```ts
import type { LaunchOptions } from "./launch-options.js";

/**
 * Moves `config.json`'s retired `owners` array to the default launch owner.
 *
 * The array modelled something the game does not have. `parseLaunchOptions`
 * accumulates into a map, so repeated `-owner` flags overwrite and only the
 * LAST survives - an install with two owners has silently had one this whole
 * time. Seeding the FIRST entry is therefore a deliberate behaviour change: at
 * the next start of any world, owner permissions move to that name. It is the
 * fix this feature exists to deliver, and the returned message is what stops it
 * being another silent change.
 *
 * Runs once: a default owner already present means the migration has happened
 * (or the operator has chosen one), and nothing is touched.
 */
export async function migrateOwners(
  storedOwners: unknown,
  store: LaunchOptions,
): Promise<string | null> {
  if (!Array.isArray(storedOwners)) return null;
  const names = storedOwners.filter((o): o is string => typeof o === "string" && o.trim().length > 0);
  if (names.length === 0) return null;

  const existing = await store.defaults();
  if (typeof existing.owner === "string") return null;

  const chosen = names[0];
  await store.setDefaults({ owner: chosen });
  if (names.length === 1) {
    return `Moved the configured owner "${chosen}" from config.json into the default launch options.`;
  }
  return (
    `config.json listed ${names.length} owners (${names.join(", ")}), but the game accepts one: ` +
    `repeated -owner flags overwrite, so this server has been applying "${names[names.length - 1]}". ` +
    `The default owner is now "${chosen}", which takes effect at the next world start. ` +
    `Set a different owner per world from the client if you want one.`
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run from `daemon/`: `npx vitest run test/launch-options-migration.test.ts`
Expected: PASS.

- [ ] **Step 5: Retire `owners`**

In **both** `daemon/src/types.ts` and `client/src/types.ts`, delete the `owners: string[];` member of `DaemonConfig` and its doc comment if it has one.

In `daemon/src/config.ts`, delete `owners: [],` from `DEFAULT_CONFIG`.

In `daemon/src/http.ts`, remove `"owners"` from `ALLOWED_CONFIG_KEYS`, leaving `lastWorld` and `stopTimeoutMs`.

Re-verify the two type files hash-match.

- [ ] **Step 6: Wire it in `daemon/src/index.ts`**

After the other stores are constructed, add:

```ts
const launchOptions = new LaunchOptions(stateFile("launch-options.json"));

// `stored` is the raw parsed config.json, so a retired key is still visible
// here even though DaemonConfig no longer declares it.
const ownerMigration = await migrateOwners((stored as { owners?: unknown }).owners, launchOptions);
if (ownerMigration !== null) console.warn(ownerMigration);
```

Add `launchOptions` to the `buildServer({ ... })` call. Import `LaunchOptions`, `migrateOwners` and `stateFile`.

- [ ] **Step 7: Run everything**

From `daemon/`: `npx vitest run` then `npx tsc --noEmit`. From `client/`: same. Fix any test that referenced `cfg.owners` by deleting the reference — do not reinstate the field.

- [ ] **Step 8: Commit**

```bash
git add daemon/src/launch-options-migration.ts daemon/test/launch-options-migration.test.ts daemon/src/index.ts daemon/src/config.ts daemon/src/http.ts daemon/src/types.ts client/src/types.ts
git commit -m "feat(daemon): migrate the owners array to a default launch owner"
```

---

### Task 5: HTTP routes

**Files:**
- Modify: `daemon/src/http.ts` — `Deps`, three route groups, and the start route
- Test: `daemon/test/http.test.ts` (append)

**Interfaces:**
- Consumes: `LaunchOptions` (Task 2), and `checkLaunchOption`, `fieldByName`, `LAUNCH_OPTION_FIELDS` (Task 1).
- Produces:
  - `GET /api/launch-options` and `PUT /api/launch-options` for the defaults
  - `GET /api/worlds/:world/launch-options` and `PUT /api/worlds/:world/launch-options`
  - `Deps.launchOptions: LaunchOptions`

- [ ] **Step 1: Write the failing tests**

Append to `daemon/test/http.test.ts`, using the file's existing app-construction helper:

```ts
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
});
```

- [ ] **Step 2: Run to verify it fails**

Run from `daemon/`: `npx vitest run test/http.test.ts`
Expected: FAIL with 404s.

- [ ] **Step 3: Add `launchOptions` to `Deps` and implement the routes**

Add to the `Deps` interface:

```ts
  launchOptions: LaunchOptions;
```

Destructure it in `buildServer` alongside the rest, import the type and the schema helpers, then add:

```ts
  /**
   * Validates a whole payload before storing any of it.
   *
   * All-or-nothing on purpose: a partial apply leaves the operator looking at a
   * form where some edits took and some did not, with a single error message to
   * explain the difference.
   */
  const checkAll = (changes: Record<string, unknown>): string | null => {
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) {
        // A null clears an option; there is nothing to range-check, but the
        // name still has to be one we know, or it is a typo that silently does
        // nothing.
        if (fieldByName(name) === undefined) return `"${name}" is not a known launch option.`;
        continue;
      }
      const bad = checkLaunchOption(name, value);
      if (bad !== null) return bad;
    }
    return null;
  };

  app.get("/api/launch-options", async () => {
    const defaults = await launchOptions.defaults();
    return {
      ok: true,
      world: null,
      effective: defaults,
      overrides: defaults,
      defaults,
      fields: [...LAUNCH_OPTION_FIELDS],
    } satisfies LaunchOptionsResponse;
  });

  app.put("/api/launch-options", async (req, reply) => {
    const changes = (req.body ?? {}) as Record<string, unknown>;
    const bad = checkAll(changes);
    if (bad !== null) return reply.code(400).send({ ok: false, error: bad });
    const defaults = await launchOptions.setDefaults(
      changes as Record<string, LaunchOptionValue | null>,
    );
    return {
      ok: true,
      world: null,
      effective: defaults,
      overrides: defaults,
      defaults,
      fields: [...LAUNCH_OPTION_FIELDS],
    } satisfies LaunchOptionsResponse;
  });

  app.get("/api/worlds/:world/launch-options", async (req) => {
    const { world } = req.params as { world: string };
    const [defaults, overrides] = await Promise.all([
      launchOptions.defaults(),
      launchOptions.forWorld(world),
    ]);
    return {
      ok: true,
      world,
      effective: { ...defaults, ...overrides },
      overrides,
      defaults,
      fields: [...LAUNCH_OPTION_FIELDS],
    } satisfies LaunchOptionsResponse;
  });

  app.put("/api/worlds/:world/launch-options", async (req, reply) => {
    const { world } = req.params as { world: string };
    const changes = (req.body ?? {}) as Record<string, unknown>;
    const bad = checkAll(changes);
    if (bad !== null) return reply.code(400).send({ ok: false, error: bad });
    const overrides = await launchOptions.setForWorld(
      world,
      changes as Record<string, LaunchOptionValue | null>,
    );
    const defaults = await launchOptions.defaults();
    return {
      ok: true,
      world,
      effective: { ...defaults, ...overrides },
      overrides,
      defaults,
      fields: [...LAUNCH_OPTION_FIELDS],
    } satisfies LaunchOptionsResponse;
  });
```

Note these routes are deliberately **not** gated on the server being stopped or on `requireNoActiveTask`: they only write a JSON file, and the game reads its arguments once at startup, so an edit during a session simply applies at the next start.

- [ ] **Step 4: Use the options in the start route**

Find the `POST /api/server/start` handler and change its `pm.start(world)` call to:

```ts
    pm.start(world, await launchOptions.effectiveFor(world));
```

- [ ] **Step 5: Add `launchOptions` to every `buildServer` call site**

```powershell
Select-String -Path daemon\test\*.ts,client\test\*.ts -Pattern "buildServer\("
```

Each needs `launchOptions: new LaunchOptions(join(root, "launch-options.json"))` using that file's existing temp root.

- [ ] **Step 6: Run everything**

From `daemon/`: `npx vitest run` then `npx tsc --noEmit`. From `client/`: same.

- [ ] **Step 7: Commit**

```bash
git add daemon/src/http.ts daemon/test/http.test.ts client/test/api.integration.test.ts
git commit -m "feat(daemon): read and write launch options over the API"
```

---

### Task 6: Client transport and dialog

**Files:**
- Modify: `client/src/api.ts`
- Create: `client/src/LaunchOptionsDialog.tsx`
- Modify: `client/src/App.tsx` — open the dialog
- Modify: `client/src/App.css` — styles, matching the world settings dialog's
- Test: `client/test/LaunchOptionsDialog.test.tsx`
- Modify: `client/test/api.test.ts` (append)

**Interfaces:**
- Consumes: `LaunchOptionsResponse`, `LaunchOptionValue`, `LaunchOptionField` (Task 1).
- Produces on the api object:
  - `launchOptions(world?: string): Promise<LaunchOptionsResponse>`
  - `saveLaunchOptions(world: string | null, changes: Record<string, LaunchOptionValue | null>): Promise<LaunchOptionsResponse>`
  - `<LaunchOptionsDialog world={string} onClose={() => void} api={Api} serverRunningThisWorld={boolean} />`

- [ ] **Step 1: Write the failing api tests**

Append to `client/test/api.test.ts`, reusing that file's existing mocking helpers:

```ts
describe("launch options", () => {
  it("GETs the daemon defaults when given no world", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await makeApi(BASE, "").launchOptions();
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/launch-options`);
  });

  it("GETs a world's options, encoding the name", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await makeApi(BASE, "").launchOptions("Jeff and Eli");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/worlds/Jeff%20and%20Eli/launch-options`);
  });

  it("PUTs world changes as JSON", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await makeApi(BASE, "").saveLaunchOptions("Tulsa", { slots: 5 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ slots: 5 });
  });

  it("PUTs defaults when the world is null", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await makeApi(BASE, "").saveLaunchOptions(null, { owner: "Jeff" });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/launch-options`);
  });

  it("surfaces the daemon's refusal verbatim", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: '"slots" must be between 1 and 250' }, 400),
    );
    await expect(makeApi(BASE, "").saveLaunchOptions("Tulsa", { slots: 999 })).rejects.toThrow(
      /between 1 and 250/,
    );
  });
});
```

- [ ] **Step 2: Add the two methods to `makeApi`**

```ts
    /**
     * A world's launch options, or the daemon-wide defaults when no world is
     * given. The response carries the field list too, so the form is built from
     * the daemon's schema rather than a second copy kept in step by hand.
     */
    launchOptions: (world?: string) =>
      request<LaunchOptionsResponse>(
        world === undefined
          ? `${base}/api/launch-options`
          : `${base}/api/worlds/${encodeURIComponent(world)}/launch-options`,
        token,
      ),
    /**
     * Applies a PARTIAL set of changes. A null value clears that option so it
     * falls back to the default; omitting a key leaves it alone. Passing null
     * for `world` edits the defaults.
     */
    saveLaunchOptions: (world: string | null, changes: Record<string, LaunchOptionValue | null>) =>
      request<LaunchOptionsResponse>(
        world === null
          ? `${base}/api/launch-options`
          : `${base}/api/worlds/${encodeURIComponent(world)}/launch-options`,
        token,
        { method: "PUT", body: JSON.stringify(changes) },
      ),
```

Import the two types.

- [ ] **Step 3: Run the api tests**

Run from `client/`: `npx vitest run test/api.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing dialog tests**

Create `client/test/LaunchOptionsDialog.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LaunchOptionsDialog } from "../src/LaunchOptionsDialog";

const FIELDS = [
  { name: "owner", type: "string", group: "identity", label: "Owner", help: "One owner." },
  { name: "slots", type: "int", group: "capacity", label: "Player slots", help: "How many.", min: 1, max: 250 },
  { name: "pausewhenempty", type: "boolean", group: "behaviour", label: "Pause when empty", help: "Stops ticking." },
];

const makeApi = (over: Partial<Record<string, unknown>> = {}) => ({
  launchOptions: vi.fn().mockResolvedValue({
    ok: true,
    world: "Tulsa",
    defaults: { owner: "Jeff", slots: 5 },
    overrides: {},
    effective: { owner: "Jeff", slots: 5 },
    fields: FIELDS,
  }),
  saveLaunchOptions: vi.fn().mockResolvedValue({
    ok: true,
    world: "Tulsa",
    defaults: { owner: "Jeff", slots: 5 },
    overrides: { slots: 20 },
    effective: { owner: "Jeff", slots: 20 },
    fields: FIELDS,
  }),
  ...over,
});

describe("LaunchOptionsDialog", () => {
  it("shows each field with its effective value", async () => {
    render(<LaunchOptionsDialog world="Tulsa" api={makeApi() as never} serverRunningThisWorld={false} onClose={() => {}} />);
    expect(await screen.findByLabelText(/owner/i)).toHaveValue("Jeff");
    expect(screen.getByLabelText(/player slots/i)).toHaveValue(5);
  });

  it("marks a value that comes from the defaults as inherited", async () => {
    render(<LaunchOptionsDialog world="Tulsa" api={makeApi() as never} serverRunningThisWorld={false} onClose={() => {}} />);
    await screen.findByLabelText(/owner/i);
    expect(screen.getAllByText(/inherited/i).length).toBeGreaterThan(0);
  });

  it("saves only what changed", async () => {
    const api = makeApi();
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    const slots = await screen.findByLabelText(/player slots/i);
    await userEvent.clear(slots);
    await userEvent.type(slots, "20");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(api.saveLaunchOptions).toHaveBeenCalledWith("Tulsa", { slots: 20 }));
  });

  it("clears an override with revert, sending null", async () => {
    const api = makeApi({
      launchOptions: vi.fn().mockResolvedValue({
        ok: true,
        world: "Tulsa",
        defaults: { slots: 5 },
        overrides: { slots: 20 },
        effective: { slots: 20 },
        fields: FIELDS,
      }),
    });
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    await screen.findByLabelText(/player slots/i);
    await userEvent.click(screen.getByRole("button", { name: /revert.*player slots/i }));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(api.saveLaunchOptions).toHaveBeenCalledWith("Tulsa", { slots: null }));
  });

  it("shows the daemon's refusal without rewording it", async () => {
    const api = makeApi({
      saveLaunchOptions: vi.fn().mockRejectedValue(new Error('"slots" must be between 1 and 250')),
    });
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    const slots = await screen.findByLabelText(/player slots/i);
    await userEvent.clear(slots);
    await userEvent.type(slots, "999");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/between 1 and 250/);
  });

  it("says changes apply at the next start when the server is running this world", async () => {
    render(<LaunchOptionsDialog world="Tulsa" api={makeApi() as never} serverRunningThisWorld onClose={() => {}} />);
    expect(await screen.findByRole("status")).toHaveTextContent(/next start/i);
  });

  it("warns that the game port needs its own firewall rule", async () => {
    render(<LaunchOptionsDialog world="Tulsa" api={makeApi() as never} serverRunningThisWorld={false} onClose={() => {}} />);
    await screen.findByLabelText(/owner/i);
    expect(screen.getByText(/firewall/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run from `client/`: `npx vitest run test/LaunchOptionsDialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 6: Write `client/src/LaunchOptionsDialog.tsx`**

Requirements the tests pin, to implement in the style of `WorldSettingsDialog.tsx` (function component, no `React.FC`, real semantic elements, every control labelled with `<label htmlFor>`):

- Loads via `api.launchOptions(world)` on mount; renders nothing but a loading state until it resolves.
- Renders fields grouped by `field.group`, in the order the daemon sent them, with a heading per group.
- Input per type: `type="text"` for string, `type="number"` for int, `type="checkbox"` for boolean. Each labelled with `field.label` and showing `field.help`.
- A field whose name is absent from `overrides` shows an "inherited from defaults" marker.
- A field present in `overrides` gets a button labelled `Revert <label> to default` which stages a `null` for that name.
- **Save sends only what changed** from the loaded state — the same partial-payload discipline `WorldSettingsDialog` uses, because sending the whole form would write overrides for every field the user never touched, permanently detaching them from the defaults.
- On rejection, render the error verbatim in a `role="alert"`.
- When `serverRunningThisWorld` is true, render a `role="status"` saying changes take effect at the world's next start.
- Render a standing note near the `port` field that the game port needs its own firewall rule, since `register-task.ps1`'s rule covers the daemon's port only.

- [ ] **Step 7: Wire it into `App.tsx`**

Add a per-world "Launch options" control beside the existing world settings one, opening the dialog for the selected world, passing `serverRunningThisWorld={status?.state === "running" && status.world === selectedWorld}`.

- [ ] **Step 8: Run everything**

From `client/`: `npx vitest run` then `npx tsc --noEmit`. From `daemon/`: same.

- [ ] **Step 9: Commit**

```bash
git add client/src client/test
git commit -m "feat(client): edit a world's launch options"
```

---

### Task 7: The seam

**Files:**
- Modify: `client/test/api.integration.test.ts`

- [ ] **Step 1: Add the seam tests**

Append, using the file's existing `baseUrl`/`TOKEN` and its real-daemon harness:

```ts
describe("launch options across the real seam", () => {
  it("stores a default and reads it back as effective for a world", async () => {
    const api = makeApi(baseUrl, TOKEN);
    await api.saveLaunchOptions(null, { owner: "Jeff" });
    const res = await api.launchOptions("Tulsa");
    expect(res.effective.owner).toBe("Jeff");
    expect(res.overrides).toEqual({});
  });

  it("lets a world override a default", async () => {
    const api = makeApi(baseUrl, TOKEN);
    await api.saveLaunchOptions(null, { owner: "Jeff" });
    await api.saveLaunchOptions("Tulsa", { owner: "Eli" });
    const res = await api.launchOptions("Tulsa");
    expect(res.effective.owner).toBe("Eli");
    expect(res.defaults.owner).toBe("Jeff");
  });

  it("clears an override with an explicit null", async () => {
    const api = makeApi(baseUrl, TOKEN);
    await api.saveLaunchOptions(null, { slots: 5 });
    await api.saveLaunchOptions("Tulsa", { slots: 20 });
    await api.saveLaunchOptions("Tulsa", { slots: null });
    expect((await api.launchOptions("Tulsa")).effective).toEqual({ slots: 5 });
  });

  it("refuses an out-of-range value with the daemon's own message", async () => {
    await expect(makeApi(baseUrl, TOKEN).saveLaunchOptions("Tulsa", { slots: 999 })).rejects.toThrow(
      /1 and 250/,
    );
  });

  it("refuses a daemon-owned argument over the wire", async () => {
    await expect(
      makeApi(baseUrl, TOKEN).saveLaunchOptions("Tulsa", { datadir: "C:\\evil" } as never),
    ).rejects.toThrow(/not a known/i);
  });

  it("serves a field list with no daemon-owned argument in it", async () => {
    const names = (await makeApi(baseUrl, TOKEN).launchOptions()).fields.map((f) => f.name);
    for (const forbidden of ["datadir", "world", "nogui"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run from `client/`: `npx vitest run test/api.integration.test.ts`
Expected: PASS. A failure here means a real request over a real socket disagrees with the mocked one — fix the transport, not the test.

- [ ] **Step 3: Commit**

```bash
git add client/test/api.integration.test.ts
git commit -m "test: prove launch options work across the real client/daemon seam"
```

---

### Task 8: Documentation and final verification

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Create: `docs/verification-2026-07-31-launch-options.md`

- [ ] **Step 1: Document the feature**

In `README.md`, add a short section covering: launch options are per world with daemon-wide defaults, they take effect at the world's next start, `owner` is one name because the game accepts one, and the game port is not the daemon port so changing it needs its own firewall rule.

In `CLAUDE.md`, record: `launch-options.json` lives in the state directory alongside `mod-sets.json`; `LAUNCH_OPTION_FIELDS` in `launch-options-schema.ts` is the single source of truth and deliberately excludes `nogui`, `datadir`, `world`, `settings` and `logs`; and that `DaemonConfig.owners` was retired because the game keeps only the last `-owner`.

House style is binding: no em dashes or en dashes, no curly quotes, plain ASCII, and none of "delve", "leverage", "utilize", "robust", "seamlessly", "comprehensive".

- [ ] **Step 2: Full verification**

From `daemon/`: `npx vitest run; "EXIT=$LASTEXITCODE"` then `npx tsc --noEmit; "EXIT=$LASTEXITCODE"`.
From `client/`: the same.
Expected: `EXIT=0` four times.

- [ ] **Step 3: Types byte-identical**

```powershell
$a = (Get-FileHash daemon\src\types.ts -Algorithm SHA256).Hash
$b = (Get-FileHash client\src\types.ts -Algorithm SHA256).Hash
"MATCH=$($a -eq $b)"
```
Expected: `MATCH=True`.

- [ ] **Step 4: Confirm `owners` is gone**

```powershell
Select-String -Path daemon\src\*.ts,client\src\*.ts,daemon\test\*.ts,client\test\*.ts -Pattern "\bowners\b"
```
Expected: no hits outside the migration module and its test.

- [ ] **Step 5: Write the verification record**

Create `docs/verification-2026-07-31-launch-options.md` in the style of the existing `docs/verification-*.md` files. Record what was run with real output, and state explicitly what was **not**: no launch was performed with real options on the live server, so the game accepting each flag is verified only against the decompiled source rather than observed; the client dialog was never exercised in a built app; and the owner migration has not run against the real `config.json`.

- [ ] **Step 6: Commit**

```bash
git add README.md CLAUDE.md docs/verification-2026-07-31-launch-options.md
git commit -m "docs: per-world launch options"
```

---

## Self-Review

**Spec coverage:** §4 model and storage → Tasks 1, 2. §5 the boundary → Tasks 1 and 3 (schema omission plus the `DAEMON_OWNED_ARGS` filter and its test). §6 migration → Task 4. §7 validation → Tasks 1 and 5. §8 API and client → Tasks 5, 6. §9 testing → Tasks 1-3, 5-7. §10 out of scope → nothing implemented.

**Type consistency:** `LaunchOptionValue`, `LaunchOptionField`, `LaunchOptionsResponse` are defined in Task 1 and used unchanged in Tasks 2, 5 and 6. `buildArgs(world, options)` and `start(world, options)` are defined in Task 3 and called in Task 5. `setDefaults`/`setForWorld`/`forWorld`/`effectiveFor`/`defaults` are defined in Task 2 and called in Tasks 4 and 5.

**Known gaps, stated rather than hidden:** no world is actually launched with these options during the plan, so "the game accepts this flag" rests on the decompiled source; the dialog is tested in jsdom, never in the built Tauri app; and the owner migration is tested against synthetic input, never against the live `config.json`.
