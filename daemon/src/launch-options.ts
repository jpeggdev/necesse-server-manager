import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeJsonDurable } from "./durable-write.js";
import { effectiveOptions } from "./launch-options-schema.js";
import { normaliseWorld } from "./mod-sets.js";
import type { LaunchOptionValue } from "./types.js";

export interface LaunchOptionsFile {
  defaults: Record<string, LaunchOptionValue>;
  /** Keyed by normalised world name, exactly as mod sets are. */
  worlds: Record<string, Record<string, LaunchOptionValue>>;
  updatedAt: string | null;
}

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

  /**
   * Serializes `setDefaults`/`setForWorld` against each other.
   *
   * Both do a load-mutate-write of the whole file, and awaiting nothing
   * between the load and the write is exactly what makes two overlapping
   * calls a lost-update race: the second call's load can complete before the
   * first call's write lands, so it mutates the pre-write state and its write
   * silently erases the first call's change. Chaining every write through
   * this queue - rather than a lock file, which would need its own crash
   * recovery - makes them run one at a time regardless of how the callers
   * overlap.
   *
   * The two `.then(ok, ok)` handlers on `advance` are what keep the queue
   * itself always resolved: if `fn` throws, `run` (returned to the caller)
   * carries that rejection untouched, but `this.queue` must still settle to
   * fulfilled or every write queued after a failing one would inherit that
   * rejection forever and never run at all.
   */
  private queue: Promise<void> = Promise.resolve();

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    const advance = run.then(
      () => undefined,
      () => undefined,
    );
    this.queue = advance;
    return run;
  }

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
    return effectiveOptions(all.defaults, all.worlds[normaliseWorld(world)] ?? {});
  }

  async setDefaults(
    changes: Record<string, LaunchOptionValue | null>,
  ): Promise<Record<string, LaunchOptionValue>> {
    return this.enqueue(async () => {
      const all = await this.load();
      all.defaults = applyChanges(all.defaults, changes);
      await this.write(all);
      return all.defaults;
    });
  }

  async setForWorld(
    world: string,
    changes: Record<string, LaunchOptionValue | null>,
  ): Promise<Record<string, LaunchOptionValue>> {
    return this.enqueue(async () => {
      const all = await this.load();
      const key = normaliseWorld(world);
      all.worlds[key] = applyChanges(all.worlds[key] ?? {}, changes);
      await this.write(all);
      return all.worlds[key];
    });
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
