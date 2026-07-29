import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stateFile } from "./state-dir.js";
import type { ConfigProblem, DaemonConfig } from "./types.js";

/**
 * The shipped defaults, and only the ones that are true of every installation.
 *
 * Every path field is deliberately empty rather than pointed at a plausible
 * location. For the five the wizard asks about, an empty value fails
 * `configProblems` and refuses the boot with a message naming the wizard; a
 * plausible-looking default would instead start a daemon confidently managing
 * directories that do not exist on this machine, which is what the previous
 * version of this file did. The five derived ones (`modsDir`, `worldsDir` and
 * the three state-directory paths) are empty here because `loadConfig`
 * computes them - and because computing them at module load would call
 * `stateFile`, which throws wherever PROGRAMDATA is unset, taking every import
 * of this module down with it.
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
  modLibraryDir: "",
  modLibraryFile: "",
  modSetsFile: "",
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
 * A BOM is compared by code point rather than written as a string literal:
 * an invisible character in source is unreadable, and an escape for one is
 * easy to mangle into a literal backslash while editing.
 */
const BOM_CODE_POINT = 0xfeff;

function stripBom(text: string): string {
  return text.charCodeAt(0) === BOM_CODE_POINT ? text.slice(1) : text;
}

/**
 * What is actually written to disk: every derived path is omitted so a saved
 * config can never carry a stale copy of one.
 *
 * The three state-directory paths belong here for the same reason `modsDir`
 * and `worldsDir` do, and the cost of leaving them out was concrete: they used
 * to default to the install directory and `saveConfig` runs on every world
 * start, so a real install's config.json stored install-directory values for
 * all three. `migrateState` copies those files into the state directory but
 * rewrites no config keys, so the daemon would have gone on reading the mod
 * library from the install directory the upgrade instructions then tell the
 * operator to delete - and `ModLibrary.load()` reads a missing manifest as an
 * empty library, so nothing would have reported the loss.
 */
export type StoredConfig = Omit<
  DaemonConfig,
  "modsDir" | "worldsDir" | "modLibraryDir" | "modLibraryFile" | "modSetsFile"
>;

/**
 * Where the daemon's own state lives, resolved now rather than at module load.
 *
 * Lazy on purpose: `stateFile` throws when neither NECESSE_MANAGER_DATA nor
 * PROGRAMDATA is set, and evaluating these at module load made that throw
 * happen on `import`, where no caller can do anything about it.
 */
export function stateDerivedPaths(): Pick<
  DaemonConfig,
  "modLibraryDir" | "modLibraryFile" | "modSetsFile"
> {
  return {
    modLibraryDir: stateFile("mod-library"),
    modLibraryFile: stateFile("mod-library.json"),
    modSetsFile: stateFile("mod-sets.json"),
  };
}

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
  // -datadir and computes the mods and worlds folders itself, and the three
  // state paths are wherever the state directory is right now; a stored copy is
  // a second source of truth for the same fact, and the only thing a second
  // source of truth can do is disagree. A file that still carries
  // modsDir/worldsDir is not silently corrected - configProblems refuses the
  // boot, because someone whose config drifted holds a wrong belief about where
  // their mods live. A stored modLibraryDir/modLibraryFile/modSetsFile is
  // different: those keys are what every pre-state-directory install has, and
  // the correct value is not the operator's to know, so they are ignored here
  // and dropped by the next saveConfig.
  return {
    ...merged,
    ...stateDerivedPaths(),
    modsDir: modsDirFor(merged.dataDir),
    worldsDir: worldsDirFor(merged.dataDir),
  };
}

export async function saveConfig(file: string, cfg: DaemonConfig): Promise<void> {
  const {
    modsDir: _m,
    worldsDir: _w,
    modLibraryDir: _ld,
    modLibraryFile: _lf,
    modSetsFile: _sf,
    ...stored
  } = cfg;
  await writeFile(file, JSON.stringify(stored satisfies StoredConfig, null, 2), "utf8");
}

/** Where the game puts its mods, given the data directory it was handed. */
export function modsDirFor(dataDir: string): string {
  return join(dataDir, "mods");
}

/** Where the game puts its world saves, given the data directory it was handed. */
export function worldsDirFor(dataDir: string): string {
  return join(dataDir, "saves", "worlds");
}

/**
 * Windows path equality: case-insensitive, indifferent to `/` versus `\` and to
 * a trailing separator. Deliberately textual - both sides are configuration, not
 * necessarily anything that exists yet, so resolving symlinks is not on offer.
 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
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

/**
 * The result of validating the configuration found in the state directory at
 * boot. A discriminated union rather than a thrown error: `index.ts` needs to
 * print every fatal problem and exit cleanly, not unwind with a stack trace,
 * and that is only testable if the decision is a return value.
 */
export type BootConfig =
  | { ok: true; cfg: DaemonConfig; configFile: string; configWarnings: string[] }
  | { ok: false; message: string };

/**
 * Reads and validates `config.json` from `dir` (the state directory), the way
 * the daemon does at every boot.
 *
 * This is the only place `configProblems` is ever called with a real,
 * disk-backed `stored` argument - `configProblems`'s own tests hand it a
 * hand-built object. A caller that passed `{}` here, or that called
 * `loadConfig` without also passing `readStoredConfig`'s result through,
 * would silently disable the drift refusal in `configProblems` while every
 * other test stayed green, which is exactly the failure this function exists
 * to make testable on its own.
 */
export async function resolveBootConfig(dir: string): Promise<BootConfig> {
  const configFile = join(dir, "config.json");
  const stored = await readStoredConfig(configFile);
  const cfg = await loadConfig(configFile);

  // The caller must not read a folder or spawn anything before this resolves
  // and is checked. A daemon that reconciles one mods folder while the game
  // loads another is worse than a daemon that did not start: the
  // wrong-mod-set launch it produces looks entirely successful.
  const problems = await configProblems(cfg, stored);
  const fatal = fatalProblems(problems);
  if (fatal.length > 0) {
    // Every one of them, not the first: fixing one path per restart is a
    // worse experience than one list.
    const lines = [`The daemon cannot start with this configuration (${configFile}):`];
    for (const p of fatal) lines.push(`  - ${p.message}`);
    return { ok: false, message: lines.join("\n") };
  }
  const configWarnings = problems.filter((p) => !p.fatal).map((p) => p.message);
  return { ok: true, cfg, configFile, configWarnings };
}
