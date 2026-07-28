import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { NotAModJarError, readModInfo } from "./mod-info.js";
import type { ModLibrary } from "./mod-library.js";
import type { ModSets } from "./mod-sets.js";
import type { ModRegistry } from "./mod-registry.js";
import { listWorlds } from "./worlds.js";
import type { ModSource } from "./types.js";

/**
 * Turning the one shared mods folder into a library plus per-world sets,
 * without changing what any world loads.
 *
 * This runs at daemon start and is idempotent: it seeds only worlds that have no
 * set yet, and adds only mods the library does not already hold. The rule it
 * exists to satisfy is that **the first start after this ships must load exactly
 * what the previous start loaded** - so every existing world is seeded with
 * precisely what is installed right now, jar for jar, and nothing else changes
 * until somebody deliberately edits a set.
 *
 * Two sources feed the library:
 *
 *  - The mods folder itself. A jar whose filename matches a `mods.json` entry is
 *    filed under that workshop id, so `Update All` keeps working on it; anything
 *    else - the hand-placed `SummonerExpansion-1.2.0-7.7.jar` this feature was
 *    written for - is adopted as a local entry.
 *  - steamcmd's workshop download cache, for managed mods whose jar is *not* in
 *    the folder right now. Those were installed through this app and then taken
 *    out by hand; recovering them costs nothing and means the library can offer
 *    them back. They are deliberately NOT added to any world's set, because they
 *    are not what the server is currently loading.
 *
 * Nothing here writes to the mods folder. Migration is purely additive, so it is
 * safe to run at boot even with a server already up that this daemon did not
 * start.
 */

export interface MigrationSummary {
  /** Mod ids taken into the library out of the mods folder. */
  adopted: string[];
  /** Mod ids recovered from steamcmd's workshop cache. */
  recovered: string[];
  /** Worlds given a set, in the order they were seeded. */
  seeded: string[];
  /** Files that could not be filed, with why. Reported, never silently dropped. */
  skipped: string[];
}

export interface MigrationOptions {
  modsDir: string;
  worldsDir: string;
  library: ModLibrary;
  sets: ModSets;
  /** `mods.json`: the only record of which jar belongs to which workshop id. */
  registry: ModRegistry;
  /** steamcmd's per-item download directory, from SteamCmd.workshopItemDir. */
  workshopItemDir: (id: string) => string;
  log?: (line: string) => void;
}

export async function migrateModSets(options: MigrationOptions): Promise<MigrationSummary> {
  const { modsDir, worldsDir, library, sets, registry, workshopItemDir } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const summary: MigrationSummary = { adopted: [], recovered: [], seeded: [], skipped: [] };

  const managed = await registry.load();
  /** Jar filename (lowercased) -> the workshop id this app installed it as. */
  const byJar = new Map(managed.map((m) => [m.jar.toLowerCase(), m.id]));

  // The mods folder, exactly as it stands. These ids are what every existing
  // world gets seeded with.
  const installed: string[] = [];
  for (const jar of await jarsIn(modsDir)) {
    const path = join(modsDir, jar);
    let id: string;
    try {
      id = (await readModInfo(path)).id;
    } catch (e) {
      // Tolerated rather than fatal: this runs at boot, and refusing to start
      // the daemon over one stray file in the mods folder helps nobody. It is
      // reported, and the first start of a world will refuse anyway rather than
      // launch a folder holding something nothing can account for.
      summary.skipped.push(`${path}: ${(e as Error).message}`);
      log(
        `Mod library migration skipped ${path}: ${(e as Error).message}` +
          (e instanceof NotAModJarError ? " No world set can name it." : ""),
      );
      continue;
    }
    if (!installed.includes(id)) installed.push(id);
    const workshopId = byJar.get(jar.toLowerCase());
    const source: ModSource =
      workshopId === undefined ? { kind: "local", how: "adopted" } : { kind: "workshop", workshopId };
    // `retain`, so a jar is taken in whenever the library does not already hold
    // those exact bytes - the same hash test reconcile uses. Gating on the id
    // would skip a second build of a mod already known and leave it deletable.
    const { stored } = await library.retain(path, source, jar);
    if (stored) summary.adopted.push(id);
  }

  // Managed mods that are not in the folder any more, recovered from the
  // steamcmd cache so the library can offer them back. Never added to a set.
  const installedJars = new Set((await jarsIn(modsDir)).map((j) => j.toLowerCase()));
  for (const mod of managed) {
    if (installedJars.has(mod.jar.toLowerCase())) continue;
    const dir = workshopItemDir(mod.id);
    const cached = (await jarsIn(dir)).find((j) => j.toLowerCase() === mod.jar.toLowerCase());
    if (cached === undefined) continue;
    const path = join(dir, cached);
    try {
      const info = await readModInfo(path);
      // Retained, never promoted: a jar sitting in steamcmd's cache is not
      // evidence of what anybody currently wants installed.
      const { stored } = await library.retain(path, { kind: "workshop", workshopId: mod.id }, cached);
      if (stored) summary.recovered.push(info.id);
    } catch (e) {
      summary.skipped.push(`${path}: ${(e as Error).message}`);
      log(`Mod library migration skipped cached ${path}: ${(e as Error).message}`);
    }
  }

  // Every world that has no set yet gets what is installed right now, so its
  // next start loads exactly what its last one did.
  for (const world of await listWorlds(worldsDir)) {
    if ((await sets.get(world.name)) !== undefined) continue;
    await sets.set(world.name, installed);
    summary.seeded.push(world.name);
  }

  if (summary.adopted.length + summary.recovered.length + summary.seeded.length > 0) {
    log(
      `Mod library migration: adopted ${summary.adopted.length} mod(s) from ${modsDir}, ` +
        `recovered ${summary.recovered.length} from the workshop cache, and seeded sets for ` +
        `${summary.seeded.length} world(s) with the ${installed.length} mod(s) installed now.`,
    );
  }
  return summary;
}

/** The `.jar` names in a directory; an absent directory has none. */
async function jarsIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".jar")).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Failed to read ${dir}: ${(e as Error).message}`);
  }
}
