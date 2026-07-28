import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { NotAModJarError, readModInfo } from "./mod-info.js";
import type { ModLibrary } from "./mod-library.js";
import type { ModInfo, ReconcileSummary } from "./types.js";

/**
 * Making the mods folder hold exactly what a world's set names, and nothing
 * else, before the game is allowed to read it.
 *
 * `%APPDATA%/Necesse/mods` is still the only folder the game loads from, and it
 * is read once at startup. So "which mods does this world run" comes down to
 * "what is in that folder at the moment the JVM starts", and this is the step
 * that makes those two agree.
 *
 * The whole procedure is arranged around one rule:
 *
 *   **Never delete a jar the library cannot restore.**
 *
 * Every jar in the folder is therefore copied into the library *before* anything
 * is removed from it, which is what makes the removal reversible. A jar somebody
 * dropped in by hand is adopted, never discarded. And if any step fails, the
 * server does not start: a half-reconciled folder must never be launched,
 * because the game would then silently run a set nobody chose and write it into
 * a save.
 */

export type ReconcileErrorKind =
  /** The set names a mod the library has no jar for. */
  | "missing-mod"
  /** A jar in the mods folder is not a Necesse mod, so it can be neither adopted nor removed. */
  | "unknown-jar"
  /** The mods folder, or a jar in it, could not be read. */
  | "unreadable"
  /** After the work, the folder does not hold exactly the set. */
  | "verify-failed";

export class ReconcileError extends Error {
  constructor(
    message: string,
    readonly kind: ReconcileErrorKind,
  ) {
    super(message);
    this.name = "ReconcileError";
  }
}

export interface ReconcileOptions {
  modsDir: string;
  library: ModLibrary;
  /** Only for the messages; the set itself is `modIds`. */
  world: string;
  modIds: string[];
  /** Where a note about a discarded duplicate goes. Defaults to console.warn. */
  log?: (line: string) => void;
}

/** One jar found in the mods folder, with what its own mod.info says it is. */
interface FolderJar {
  jar: string;
  path: string;
  info: ModInfo;
}

export async function reconcileMods(options: ReconcileOptions): Promise<ReconcileSummary> {
  const { modsDir, library, world, modIds } = options;
  const log = options.log ?? ((line: string) => console.warn(line));
  const wanted = [...new Set(modIds)];

  // 1. Read the folder and work out what everything in it actually is. Nothing
  //    is written yet: every way this can fail must fail before that.
  const present = await scanModsFolder(modsDir);
  const { keepers, duplicates } = resolveDuplicates(present);

  // 2. Adopt before pruning. Anything the library does not already hold a jar
  //    for goes in first, so that step 3 below is reversible. This is additive
  //    only - it never touches the mods folder - so it is safe to do before the
  //    set has even been checked.
  const adopted: string[] = [];
  for (const found of keepers) {
    if (await library.has(found.info.id)) continue;
    await library.add(found.path, { kind: "local", how: "adopted" }, found.jar);
    adopted.push(found.jar);
  }

  // 3. Resolve the set. A missing mod refuses here, with the folder still
  //    exactly as it was found - launching a partial set is the one outcome
  //    that must never happen.
  const resolved = new Map<string, { jar: string; path: string }>();
  const missing: string[] = [];
  for (const id of wanted) {
    const hit = await library.resolve(id);
    if (hit === undefined) missing.push(id);
    else resolved.set(id, { jar: hit.entry.jar, path: hit.path });
  }
  if (missing.length > 0) {
    throw new ReconcileError(
      `World ${JSON.stringify(world)} is set to load ${missing.length === 1 ? "a mod" : "mods"} the ` +
        `library has no jar for: ${missing.join(", ")}. The server was not started - it would have ` +
        `loaded a partial set. Re-add the mod, or take it out of this world's set.`,
      "missing-mod",
    );
  }

  // 4. Prune, then copy. A jar stays only if the set names its id AND it is the
  //    same filename the library holds - an older jar of a wanted mod is
  //    replaced, which is what makes a set follow updates.
  const kept: string[] = [];
  const removed: string[] = [];
  for (const found of present) {
    const want = resolved.get(found.info.id);
    const isDuplicate = duplicates.includes(found);
    if (want !== undefined && !isDuplicate && want.jar === found.jar) {
      kept.push(found.jar);
      continue;
    }
    if (isDuplicate) {
      log(
        `Removing ${found.path}: mod ${found.info.id} is present more than once in the mods folder, ` +
          `and the game would load it twice. The library's single copy is what the server will run.`,
      );
    }
    await rm(found.path, { force: true });
    removed.push(found.jar);
  }

  await mkdir(modsDir, { recursive: true });
  const copied: string[] = [];
  for (const [, want] of resolved) {
    if (kept.includes(want.jar)) continue;
    await copyFile(want.path, join(modsDir, want.jar));
    copied.push(want.jar);
  }

  // 5. Prove it, by reading the folder back rather than by trusting the work
  //    above. The cost is one more pass over a handful of jars; the thing it
  //    catches is the game being launched against a folder nobody verified.
  await verify(modsDir, wanted, world);

  return { world, modIds: wanted, adopted, removed, copied, kept };
}

/**
 * The mod ids installed in the mods folder right now.
 *
 * What a world with no set of its own is seeded with, so that its first start
 * loads exactly what the folder already held. Uses the same scan as reconcile,
 * so it refuses on the same unaccountable jar rather than seeding a set that
 * would then fail to reconcile.
 */
export async function installedModIds(modsDir: string): Promise<string[]> {
  const { keepers } = resolveDuplicates(await scanModsFolder(modsDir));
  return keepers.map((k) => k.info.id);
}

/**
 * Every `.jar` in the folder, with its `mod.info`.
 *
 * A jar that is not a Necesse mod stops everything, and deliberately: it cannot
 * be adopted (there is no id to file it under) and so it cannot be deleted
 * either without breaking the invariant. Refusing, and naming the file, leaves
 * the operator a folder they can fix; the alternatives are deleting something
 * unrecoverable or launching a folder that still has it in.
 */
async function scanModsFolder(modsDir: string): Promise<FolderJar[]> {
  let files: string[] = [];
  try {
    files = await readdir(modsDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ReconcileError(
        `Failed to read the mods folder at ${modsDir}: ${(e as Error).message}`,
        "unreadable",
      );
    }
    return [];
  }
  const out: FolderJar[] = [];
  // Sorted so that two runs over the same folder make the same decisions, and
  // the duplicate tie-break below is not left to readdir's ordering.
  for (const jar of files.filter((f) => f.toLowerCase().endsWith(".jar")).sort()) {
    const path = join(modsDir, jar);
    let info: ModInfo;
    try {
      info = await readModInfo(path);
    } catch (e) {
      if (e instanceof NotAModJarError) {
        throw new ReconcileError(
          `${e.message} It is in the mods folder, where this daemon can neither file it under a ` +
            `mod id nor remove it without losing the only copy. Move it out of ${modsDir} and try ` +
            `again.`,
          "unknown-jar",
        );
      }
      throw new ReconcileError(
        `Failed to read ${path}: ${(e as Error).message}`,
        "unreadable",
      );
    }
    out.push({ jar, path, info });
  }
  return out;
}

/**
 * Splits the folder's jars into the one to keep per mod id and the rest.
 *
 * Two jars declaring the same id - an old and a new version both sitting in the
 * folder - is a state the game reads as the mod being present twice. The
 * library holds one jar per id and so must the folder, so the higher declared
 * `version` wins, with the filename as a tie-break. The loser is removed only
 * after the winner is safely in the library, so the *mod* is always restorable
 * even though that particular jar is not.
 */
function resolveDuplicates(present: FolderJar[]): { keepers: FolderJar[]; duplicates: FolderJar[] } {
  const best = new Map<string, FolderJar>();
  const duplicates: FolderJar[] = [];
  for (const found of present) {
    const current = best.get(found.info.id);
    if (current === undefined) {
      best.set(found.info.id, found);
      continue;
    }
    const winner = compareVersions(found.info.version, current.info.version) > 0 ? found : current;
    duplicates.push(winner === found ? current : found);
    best.set(found.info.id, winner);
  }
  return { keepers: [...best.values()], duplicates };
}

/** Compares two `mod.info` version strings numerically, component by component. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split(/[^0-9]+/).filter((s) => s.length > 0).map(Number);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // Neither declares a higher version: keep the one whose filename sorts later,
  // which for the game's own naming (`Mod-1.2.0-7.7.jar`) is the newer build.
  return a.localeCompare(b);
}

/** Reads the folder back and insists it now holds exactly the set, once each. */
async function verify(modsDir: string, wanted: string[], world: string): Promise<void> {
  const after = await scanModsFolder(modsDir);
  const seen = new Map<string, string[]>();
  for (const found of after) {
    seen.set(found.info.id, [...(seen.get(found.info.id) ?? []), found.jar]);
  }
  const fail = (why: string): never => {
    throw new ReconcileError(
      `The mods folder at ${modsDir} does not hold exactly the mod set for world ` +
        `${JSON.stringify(world)} after reconciling (${why}). The server was not started; the ` +
        `folder is in whatever state that left it, and must not be launched until it is sorted out.`,
      "verify-failed",
    );
  };
  for (const id of wanted) {
    const jars = seen.get(id);
    if (jars === undefined) fail(`mod ${id} is not there`);
    else if (jars.length > 1) fail(`mod ${id} is there more than once, as ${jars.join(" and ")}`);
  }
  for (const [id, jars] of seen) {
    if (!wanted.includes(id)) fail(`mod ${id} (${jars.join(", ")}) is there but not in the set`);
  }
}
