import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonConfig } from "./types.js";

/**
 * The daemon's own directory - the parent of `src/` when running from source
 * and of `dist/` when running the build, which resolve to the same place. It is
 * where `config.json` and `mods.json` already live, and where the mod library
 * and the per-world sets default to, for the reason spelled out on
 * `DaemonConfig.modLibraryDir`: not `serverRoot`, which steamcmd validates and
 * prunes.
 */
export const DAEMON_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The live data directory: what `%APPDATA%\Necesse` resolves to for `jeffp`,
 * spelled out so nothing depends on which account the daemon runs as. The two
 * folder defaults below are derived from it rather than repeated, so the
 * shipped default can never be the drifted configuration `dataDirConflict`
 * exists to reject.
 */
const DEFAULT_DATA_DIR = "C:\\Users\\jeffp\\AppData\\Roaming\\Necesse";

export const DEFAULT_CONFIG: DaemonConfig = {
  port: 8710,
  serverRoot: "C:\\necesseserver",
  javaExe: "C:\\necesseserver\\jre\\bin\\java.exe",
  serverJar: "C:\\necesseserver\\Server.jar",
  steamcmdExe: "C:\\Users\\jeffp\\steam\\steamcmd.exe",
  dataDir: DEFAULT_DATA_DIR,
  modsDir: join(DEFAULT_DATA_DIR, "mods"),
  worldsDir: join(DEFAULT_DATA_DIR, "saves", "worlds"),
  modLibraryDir: join(DAEMON_DIR, "mod-library"),
  modLibraryFile: join(DAEMON_DIR, "mod-library.json"),
  modSetsFile: join(DAEMON_DIR, "mod-sets.json"),
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
  // Empty by design. The real key is written into config.json on the server
  // itself and must never enter the repo; every Steam call except workshop
  // search works anonymously without it.
  steamApiKey: "",
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

export async function loadConfig(file: string): Promise<DaemonConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Failed to read config at ${file}: ${(e as Error).message}`);
    }
    const cfg = { ...DEFAULT_CONFIG };
    await saveConfig(file, cfg);
    return cfg;
  }
  let parsed: Partial<DaemonConfig>;
  try {
    // Hand-editing this file on Windows is the documented way to set the Steam
    // key, and Notepad, VS Code and PowerShell's Set-Content -Encoding UTF8 all
    // add a BOM that JSON.parse rejects. Tolerate it rather than refuse to boot.
    parsed = JSON.parse(stripBom(raw));
  } catch (e) {
    throw new Error(`Failed to parse config at ${file}: ${(e as Error).message}`);
  }
  return { ...DEFAULT_CONFIG, ...parsed };
}

export async function saveConfig(file: string, cfg: DaemonConfig): Promise<void> {
  await writeFile(file, JSON.stringify(cfg, null, 2), "utf8");
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

/**
 * Why this config must not be started, or null if it is coherent.
 *
 * `dataDir` is what the *game* is told (`-datadir`); `modsDir` and `worldsDir`
 * are what the *daemon* itself reads and writes. They name the same two folders
 * by two routes, and nothing keeps them in step - config.json on the server
 * carries all three literally, and the two that predate `dataDir` are the ones a
 * person is likely to edit.
 *
 * Drift is silent and destructive in both directions: reconcile would rewrite
 * one mods folder to a world's set while the game loaded a different folder
 * entirely, so the server comes up with the wrong mods (or none) and reports a
 * completely successful launch, and the daemon lists worlds the game will never
 * see. There is no half-right recovery from that, so the daemon refuses to boot
 * instead of picking a winner.
 */
export function dataDirConflict(cfg: DaemonConfig): string | null {
  const wrong: string[] = [];
  const wantMods = modsDirFor(cfg.dataDir);
  const wantWorlds = worldsDirFor(cfg.dataDir);
  if (!samePath(cfg.modsDir, wantMods)) {
    wrong.push(`modsDir is "${cfg.modsDir}" but dataDir requires "${wantMods}"`);
  }
  if (!samePath(cfg.worldsDir, wantWorlds)) {
    wrong.push(`worldsDir is "${cfg.worldsDir}" but dataDir requires "${wantWorlds}"`);
  }
  if (wrong.length === 0) return null;
  return (
    `Config is inconsistent with dataDir "${cfg.dataDir}": ${wrong.join("; ")}. ` +
    `The daemon reads and writes modsDir/worldsDir while the game is launched with ` +
    `-datadir, so if they disagree the daemon prepares one mods folder and the game ` +
    `loads another - a wrong-mod-set launch that neither side reports as a failure. ` +
    `Fix config.json so all three agree.`
  );
}
