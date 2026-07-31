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
  /**
   * When `config.json`'s retired `owners` array was migrated, or null if it
   * never has been. A durable marker rather than an inference from current
   * state: see `markOwnersMigrated`.
   */
  ownersMigratedAt: string | null;
}

/**
 * World keys are caller-supplied, and `__proto__` is a legal Windows filename.
 * On an ordinary object `worlds["__proto__"] = {...}` runs the inherited
 * setter and replaces the PROTOTYPE instead of storing anything, so the write
 * is echoed back to the client as saved, nothing is persisted, and the next
 * read finds nothing - the silent-success shape this whole feature exists to
 * remove. Reading it back before anything is stored is just as bad: the
 * inherited value is Object.prototype, which is not nullish, so `?? {}` never
 * fires and the route answers with that object. A null-prototype record has
 * neither the setter nor anything to inherit.
 */
function emptyWorlds(): Record<string, Record<string, LaunchOptionValue>> {
  return Object.create(null) as Record<string, Record<string, LaunchOptionValue>>;
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
      return { defaults: {}, worlds: emptyWorlds(), updatedAt: null, ownersMigratedAt: null };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LaunchOptionsFile>;
      return {
        defaults: parsed.defaults ?? {},
        // JSON.parse defines `__proto__` as a real own property, but assigning
        // one onto a plain object would not, so the copy target is null-proto.
        worlds: Object.assign(emptyWorlds(), parsed.worlds),
        updatedAt: parsed.updatedAt ?? null,
        ownersMigratedAt: parsed.ownersMigratedAt ?? null,
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

  /** True once the `owners` migration has recorded that it ran. */
  async ownersMigrated(): Promise<boolean> {
    return (await this.load()).ownersMigratedAt !== null;
  }

  /**
   * Records that the `owners` migration has run, so it can never run twice.
   *
   * The guard used to be "a default owner exists", which is a fact about
   * current state rather than about history: an operator who deliberately
   * cleared the default owner got it re-seeded from the stale `owners` array
   * at the next daemon start, silently, because `owners` round-trips in
   * `config.json` forever and nothing there is ever removed on write.
   *
   * Writing the marker is a second write rather than part of the seed. A crash
   * between the two leaves the owner seeded and the marker absent, which the
   * next boot reads as "a default owner is already set" and marks migrated
   * without touching it - the same end state, reached one boot later.
   */
  async markOwnersMigrated(): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      if (all.ownersMigratedAt !== null) return;
      all.ownersMigratedAt = new Date().toISOString();
      await this.write(all);
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
