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
      return { defaults: {}, worlds: {}, updatedAt: null };
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
