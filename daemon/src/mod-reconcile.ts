import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { NotAModJarError, readModInfoFromBytes } from "./mod-info.js";
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
 *   **Never delete a jar the library cannot restore - THAT jar, not merely
 *   something else carrying the same mod id.**
 *
 * Every jar in the folder whose exact bytes the library does not already hold is
 * therefore copied into it *before* anything is removed, which is what makes the
 * removal reversible. That test is a hash, not an id, and the difference is not
 * academic: the library holding `Mod-1.0.jar` does nothing for a hand-dropped
 * `Mod-2.0.jar` that may be the only copy in existence, and gating on the id
 * alone deletes it. Every jar is retained, including the loser of a duplicate
 * pair, before a single one is pruned.
 *
 * And if any step fails, the server does not start: a half-reconciled folder
 * must never be launched, because the game would then silently run a set nobody
 * chose and write it into a save.
 */

export type ReconcileErrorKind =
  /** The set names a mod the library has no jar for. */
  | "missing-mod"
  /** A jar in the mods folder is not a Necesse mod, so it can be neither adopted nor removed. */
  | "unknown-jar"
  /** Two mods in the set have jars of the same name, so only one could exist in the folder. */
  | "jar-collision"
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
  /**
   * Of the file's bytes. What decides both whether the library already holds
   * this jar and whether the folder already has the right one - never the
   * filename, which two different builds of one mod routinely share.
   */
  sha256: string;
}

/** One mod the set names, resolved to the library jar that will be installed. */
interface WantedJar {
  /** The name it gets in the mods folder. */
  jar: string;
  /** Where the library keeps it. */
  path: string;
  sha256: string;
}

export async function reconcileMods(options: ReconcileOptions): Promise<ReconcileSummary> {
  const { modsDir, library, world, modIds } = options;
  const log = options.log ?? ((line: string) => console.warn(line));
  const wanted = [...new Set(modIds)];

  // 1. Read the folder and work out what everything in it actually is. Nothing
  //    is written yet: every way this can fail must fail before that.
  const present = await scanModsFolder(modsDir);
  const { keepers, duplicates } = resolveDuplicates(present);

  // 2. Retain before pruning - EVERY jar whose exact bytes the library does not
  //    already hold, losers of a duplicate pair included, because step 4 deletes
  //    those too and a jar it cannot restore must never be one of them.
  //
  //    Keepers go first so that, for a mod the library has never heard of, the
  //    jar this pass would install is the one that becomes current. `retain`
  //    never promotes over an existing entry: dropping an old jar into the
  //    folder must not silently downgrade every world that loads that mod, nor
  //    undo an `Update All`.
  //
  //    Additive only - it never touches the mods folder - so it is safe to do
  //    before the set has even been checked.
  const adopted: string[] = [];
  for (const found of [...keepers, ...duplicates]) {
    const { stored } = await library.retain(
      found.path,
      { kind: "local", how: "adopted" },
      found.jar,
    );
    if (stored) adopted.push(found.jar);
  }

  // 3. Resolve the set. A missing mod refuses here, with the folder still
  //    exactly as it was found - launching a partial set is the one outcome
  //    that must never happen.
  const resolved = new Map<string, WantedJar>();
  const missing: string[] = [];
  for (const id of wanted) {
    const hit = await library.resolve(id);
    if (hit === undefined) missing.push(id);
    else resolved.set(id, { jar: hit.entry.jar, path: hit.path, sha256: hit.entry.sha256 });
  }
  if (missing.length > 0) {
    throw new ReconcileError(
      `World ${JSON.stringify(world)} is set to load ${missing.length === 1 ? "a mod" : "mods"} the ` +
        `library has no jar for: ${missing.join(", ")}. The server was not started - it would have ` +
        `loaded a partial set. Re-add the mod, or take it out of this world's set.`,
      "missing-mod",
    );
  }
  // Two mods whose current jars share a filename cannot both sit in one folder:
  // the second copy would silently overwrite the first, and the set would be
  // one mod short. Caught here, named, and refused before anything is written -
  // `verify` would catch it too, but only as "some mod is not there", which is
  // an unstartable world with no actionable diagnosis.
  assertNoFilenameCollision(resolved, world);

  // 4. Prune, then copy. A jar stays only if the set names its id AND its BYTES
  //    are the library's current ones for that mod - not merely its filename.
  //
  //    Matching on the name was a silent wrong-build launch: two builds of one
  //    mod routinely ship under one filename (`CorruptedRaidMod.jar` carries no
  //    version in its name at all), so a differing build sitting in the folder
  //    was retained into the library, then kept in the folder, and the game ran
  //    it while the library, GET /api/mods/library and `verify` all reported the
  //    world was running the other one. The hash is the only thing that can tell
  //    those apart. The name still has to match too, so that the folder ends up
  //    a faithful mirror of the library rather than the right bytes under a
  //    stale label.
  const kept: string[] = [];
  const removed: string[] = [];
  for (const found of present) {
    const want = resolved.get(found.info.id);
    const isDuplicate = duplicates.includes(found);
    if (want !== undefined && !isDuplicate && want.sha256 === found.sha256 && want.jar === found.jar) {
      kept.push(found.jar);
      continue;
    }
    if (isDuplicate) {
      log(
        `Removing ${found.path}: mod ${found.info.id} is present more than once in the mods folder, ` +
          `and the game would load it twice. Both jars are in the mod library; the current one is ` +
          `what the server will run.`,
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
  //    above - and by hashing it, so "the right mods are there" is a claim about
  //    the bytes the JVM will load rather than about the names on the files. The
  //    cost is one more pass over a handful of jars; the thing it catches is the
  //    game being launched against a folder nobody verified.
  await verify(modsDir, resolved, world);

  return { world, modIds: wanted, adopted, removed, copied, kept };
}

/** Refuses a set whose mods would land on one filename in the mods folder. */
function assertNoFilenameCollision(resolved: Map<string, WantedJar>, world: string): void {
  const byJar = new Map<string, string[]>();
  for (const [id, want] of resolved) {
    byJar.set(want.jar.toLowerCase(), [...(byJar.get(want.jar.toLowerCase()) ?? []), id]);
  }
  for (const [jar, ids] of byJar) {
    if (ids.length < 2) continue;
    throw new ReconcileError(
      `World ${JSON.stringify(world)} is set to load ${ids.length} mods whose jars are all named ` +
        `"${jar}": ${ids.join(", ")}. Only one of them can exist in the mods folder at a time, so ` +
        `the server was not started. Re-upload one of them under a different filename, or take it ` +
        `out of this world's set.`,
      "jar-collision",
    );
  }
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
    let sha: string;
    try {
      // Read once and hash the same bytes the mod.info was parsed from, so the
      // hash the library is asked about is provably this file's.
      const bytes = await readFile(path);
      sha = createHash("sha256").update(bytes).digest("hex");
      info = await readModInfoFromBytes(bytes, path);
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
    out.push({ jar, path, info, sha256: sha });
  }
  return out;
}

/**
 * Splits the folder's jars into the one to install per mod id and the rest.
 *
 * Two jars declaring the same id - an old and a new build both sitting in the
 * folder - is a state the game reads as the mod being present twice, so only one
 * can stay. **Which one is a heuristic, and it can be wrong.** The higher
 * declared `mod.info` version wins; when both declare the same version, or
 * neither declares one at all - and mods routinely ship a new build without
 * bumping it - the filename decides, on the game's own `Mod-1.2.0-7.7.jar`
 * naming, where the later-sorting name is usually the later build. "Usually".
 *
 * Nothing rests on getting it right, which is why a heuristic is acceptable
 * here: BOTH jars are retained in the library before either is pruned, so a
 * wrong guess costs a start with the wrong build and is undone by pointing the
 * set at the other one. It would not be acceptable if the loser were deleted.
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
    const winner = preferred(found, current);
    duplicates.push(winner === found ? current : found);
    best.set(found.info.id, winner);
  }
  return { keepers: [...best.values()], duplicates };
}

/** Which of two jars for one mod this pass installs. See `resolveDuplicates`. */
function preferred(a: FolderJar, b: FolderJar): FolderJar {
  const byVersion = compareVersions(a.info.version, b.info.version);
  if (byVersion !== 0) return byVersion > 0 ? a : b;
  // Deliberately the FILENAMES, not the version strings - which are equal by the
  // time control reaches here, so comparing them again would decide nothing and
  // leave the outcome to readdir's ordering.
  return a.jar.localeCompare(b.jar) >= 0 ? a : b;
}

/**
 * Compares two `mod.info` version strings numerically, component by component.
 * Returns 0 when they carry the same numbers, including when both are empty.
 */
function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split(/[^0-9]+/).filter((s) => s.length > 0).map(Number);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Reads the folder back and insists it now holds exactly the set, once each,
 * and with the library's current BYTES for every mod.
 *
 * Checking ids alone would agree with a folder holding a different build of the
 * right mod - which is precisely the state that makes the game run one thing
 * while every surface reports another. `scanModsFolder` already hashes what it
 * reads, so this costs nothing extra.
 */
async function verify(
  modsDir: string,
  resolved: Map<string, WantedJar>,
  world: string,
): Promise<void> {
  const after = await scanModsFolder(modsDir);
  const seen = new Map<string, FolderJar[]>();
  for (const found of after) {
    seen.set(found.info.id, [...(seen.get(found.info.id) ?? []), found]);
  }
  const fail = (why: string): never => {
    throw new ReconcileError(
      `The mods folder at ${modsDir} does not hold exactly the mod set for world ` +
        `${JSON.stringify(world)} after reconciling (${why}). The server was not started; the ` +
        `folder is in whatever state that left it, and must not be launched until it is sorted out.`,
      "verify-failed",
    );
  };
  for (const [id, want] of resolved) {
    const found = seen.get(id);
    if (found === undefined) {
      fail(`mod ${id} is not there`);
    } else if (found.length > 1) {
      fail(`mod ${id} is there more than once, as ${found.map((f) => f.jar).join(" and ")}`);
    } else if (found[0].sha256 !== want.sha256) {
      fail(
        `mod ${id} is there as ${found[0].jar}, but those are not the bytes the library holds for ` +
          `it - the game would load a different build of that mod than anything here reports`,
      );
    }
  }
  for (const [id, found] of seen) {
    if (!resolved.has(id)) {
      fail(`mod ${id} (${found.map((f) => f.jar).join(", ")}) is there but not in the set`);
    }
  }
}
