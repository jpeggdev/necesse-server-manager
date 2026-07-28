import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModSet } from "./types.js";

/**
 * Which mods each world loads.
 *
 * Keyed by world name, normalised for case. That is not a nicety: Windows
 * filenames are case-insensitive, `listWorlds` reads world names off disk, and
 * `worldZipPath` already resolves a requested name against that listing
 * case-insensitively - so `summoner world` and `Summoner World` are one world
 * everywhere else in this daemon and must be one world here too. A set filed
 * under the wrong case is a set that silently never applies, and the first
 * anyone would know of it is a start that loaded the wrong mods.
 *
 * The set stores mod ids, never jar filenames. A jar's name carries its version
 * (`AutoTorch-1.0.jar` -> `AutoTorch-1.1.jar`), so a set of filenames would break
 * on every update; a set of ids follows the mod, which is the decision recorded
 * in docs/mod-sets-design.md.
 */

/** The lookup key for a world name. Trimmed and lowercased, nothing else. */
export function normaliseWorld(world: string): string {
  return world.trim().toLowerCase();
}

export class ModSets {
  constructor(private file: string) {}

  /** Every set, keyed by normalised world name. */
  async load(): Promise<Record<string, ModSet>> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Failed to read mod sets at ${this.file}: ${(e as Error).message}`);
      }
      return {};
    }
    try {
      return JSON.parse(raw) as Record<string, ModSet>;
    } catch (e) {
      throw new Error(`Failed to parse mod sets at ${this.file}: ${(e as Error).message}`);
    }
  }

  async get(world: string): Promise<ModSet | undefined> {
    return (await this.load())[normaliseWorld(world)];
  }

  /**
   * Records a world's set. Duplicate ids are collapsed, since a set is a set:
   * naming a mod twice would ask reconcile to install one jar twice, which is
   * not a thing that can happen, and the request is not wrong enough to refuse.
   */
  async set(world: string, modIds: string[]): Promise<ModSet> {
    const all = await this.load();
    const entry: ModSet = {
      world: world.trim(),
      modIds: [...new Set(modIds)],
      updatedAt: new Date().toISOString(),
    };
    all[normaliseWorld(world)] = entry;
    await this.write(all);
    return entry;
  }

  async remove(world: string): Promise<ModSet | undefined> {
    const all = await this.load();
    const key = normaliseWorld(world);
    const found = all[key];
    if (found === undefined) return undefined;
    delete all[key];
    await this.write(all);
    return found;
  }

  private async write(all: Record<string, ModSet>): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2), "utf8");
  }
}
