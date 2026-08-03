import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeJsonDurable } from "./durable-write.js";
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

/**
 * World keys are caller-supplied, and `__proto__` is a legal Windows filename,
 * so it is a possible world name and `normaliseWorld` only lowercases it - it
 * reaches the key unchanged. On an ordinary object every operation here is
 * then wrong, and all of them quietly:
 *
 * - `all["__proto__"] = entry` runs Object.prototype's inherited setter and
 *   replaces the PROTOTYPE instead of storing anything. `JSON.stringify` does
 *   not serialise a prototype, so nothing is written, while `set` still
 *   returns the entry and the route answers 200 with it.
 * - `all["__proto__"]` reads back Object.prototype, which is not `undefined`,
 *   so `setFor` and `migrate` both take their "this world already has a set"
 *   branch and then read `.modIds` off it as undefined.
 * - `delete all["__proto__"]` removes nothing but is reported as a removal.
 *
 * A null-prototype record has neither the setter nor anything to inherit, so
 * the key behaves like any other. This is the same fix, for the same reason,
 * as `emptyWorlds` in launch-options.ts.
 */
function emptySets(): Record<string, ModSet> {
  return Object.create(null) as Record<string, ModSet>;
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
      return emptySets();
    }
    try {
      // JSON.parse defines `__proto__` as a real own property, but assigning
      // one onto a plain object would not, so the copy target is null-proto.
      return Object.assign(emptySets(), JSON.parse(raw) as Record<string, ModSet>);
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
    // Atomic, for the same reason the library's manifest is: a file truncated
    // by a crash mid-write makes `load` throw on every call, and every start
    // then refuses until somebody repairs it by hand.
    await writeJsonDurable(this.file, all);
  }
}
