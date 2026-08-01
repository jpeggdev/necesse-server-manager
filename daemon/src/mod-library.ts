import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeJsonDurable } from "./durable-write.js";
import { checkJarFilename, readModInfo, readModInfoFromBytes, safeModId } from "./mod-info.js";
import type { ModInfo, ModLibraryEntry, ModLibraryJar, ModSource } from "./types.js";

/**
 * A library jar whose storage name is known. `ModLibraryJar.file` is optional
 * because a manifest written before storage names were split out of `jar` has
 * none; `jarsOf` resolves that fallback once so nothing downstream joins a path
 * out of a possibly-absent field.
 */
export type StoredJar = ModLibraryJar & { file: string };

/**
 * The library: every jar this daemon has ever seen, kept where nothing else will
 * touch it, with one of them per mod id marked as the current one.
 *
 * The mods folder the game reads is not a safe place to keep anything, because
 * reconciling it to a world's set deletes from it. The library is what makes
 * that deletion reversible, and the rule it has to satisfy is stronger than it
 * first looks:
 *
 *   **Never delete a jar the library cannot restore - THAT jar, not merely
 *   something else carrying the same mod id.**
 *
 * Two versions of one mod are two different files. A hand-dropped
 * `Mod-2.0.jar`, which may be the only copy in existence, is not made
 * restorable by the library happening to hold `Mod-1.0.jar` under the same id.
 * So membership is decided by the **hash of the bytes** (`holds`), never by the
 * id, and adding a jar never overwrites one already there: the old one moves
 * into `superseded` and stays on disk. Disk is cheap; a jar that exists nowhere
 * is not.
 *
 * `add` makes a jar current - what an install, an `Update All` and an upload do,
 * so that reconcile, which installs the current jar, actually picks a new
 * version up. `retain` guarantees the bytes are held without disturbing which
 * jar is current - what adopting out of the mods folder does, so that dropping
 * an old jar into that folder cannot silently downgrade a world.
 *
 * Layout: `<dir>/<safe mod id>/<filename>.jar`, manifest at `<manifestFile>`.
 * The per-id subfolder keeps the original filename, which is what the game logs
 * and what a person recognises, while making two mods that happen to ship the
 * same jar name impossible to collide.
 */
export class ModLibrary {
  constructor(
    private manifestFile: string,
    private dir: string,
  ) {}

  async load(): Promise<ModLibraryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.manifestFile, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `Failed to read mod library manifest at ${this.manifestFile}: ${(e as Error).message}`,
        );
      }
      return [];
    }
    try {
      return JSON.parse(raw) as ModLibraryEntry[];
    } catch (e) {
      throw new Error(
        `Failed to parse mod library manifest at ${this.manifestFile}: ${(e as Error).message}`,
      );
    }
  }

  async get(id: string): Promise<ModLibraryEntry | undefined> {
    return (await this.load()).find((m) => m.id === id);
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  /**
   * The entry whose current jar came from this workshop id.
   *
   * Not `get(id)`: the library files entries under the mod id read out of the
   * jar, while a managed mod is keyed by its Steam published-file id. The two
   * are different keyspaces and a lookup by the wrong one silently finds
   * nothing.
   */
  async currentForWorkshopId(workshopId: string): Promise<ModLibraryEntry | undefined> {
    return (await this.load()).find(
      (e) => e.source.kind === "workshop" && e.source.workshopId === workshopId,
    );
  }

  /**
   * Where a jar of this mod is on disk, or would be. Defaults to the current
   * one. Addressed by its storage name (`file`), which is the only name that is
   * unique within the folder - `jar` is the label the mods folder gets and two
   * builds can share it.
   */
  jarPath(entry: Pick<ModLibraryEntry, "id" | "jar" | "file">, file?: string): string {
    // `?? entry.jar` covers a manifest written before storage names were split
    // out, where the two were always the same string.
    return join(this.dir, safeModId(entry.id), file ?? entry.file ?? entry.jar);
  }

  /**
   * Every jar the library holds for this mod, the current one first, each with
   * its storage name resolved - so callers that address a file on disk never
   * have to repeat the `?? jar` fallback an older manifest needs.
   */
  jarsOf(entry: ModLibraryEntry): StoredJar[] {
    return [
      {
        jar: entry.jar,
        file: entry.file ?? entry.jar,
        sha256: entry.sha256,
        sizeBytes: entry.sizeBytes,
        addedAt: entry.addedAt,
        source: entry.source,
      },
      ...(entry.superseded ?? []).map((j) => ({ ...j, file: j.file ?? j.jar })),
    ];
  }

  /**
   * Whether the library already holds these exact bytes for this mod.
   *
   * The question reconcile must answer before it deletes anything, and the
   * reason it is asked about a hash rather than about an id: "we have some jar
   * for this mod" does not make *this* jar restorable, and acting as though it
   * did is how the only copy of a hand-placed jar gets destroyed.
   */
  async holds(id: string, sha256Hex: string): Promise<boolean> {
    const entry = await this.get(id);
    if (entry === undefined) return false;
    return this.jarsOf(entry).some((j) => j.sha256 === sha256Hex);
  }

  /**
   * Puts a jar in and makes it the current one for its mod.
   *
   * What an install, an `Update All` and an upload do: the current jar is what
   * reconcile copies into the mods folder, so a new version has to land here or
   * the next start quietly reinstates the old one. Whatever it replaces is
   * retained, never deleted.
   */
  async add(sourcePath: string, source: ModSource, jarName?: string): Promise<ModLibraryEntry> {
    return this.store(sourcePath, source, jarName, true);
  }

  /**
   * Guarantees the library holds these bytes, without changing which jar is
   * current.
   *
   * What adopting out of the mods folder does. Promotion would be wrong there:
   * somebody dropping an old jar into the folder must not silently downgrade
   * every world that loads that mod, and `Update All` writing a new version into
   * the library must not be undone by the old jar still sitting in the folder.
   * When the library has never heard of the mod there is nothing to preserve, so
   * the jar becomes current by default.
   *
   * Reports whether anything was actually written, so a caller can say what it
   * adopted rather than guessing.
   */
  async retain(
    sourcePath: string,
    source: ModSource,
    jarName?: string,
  ): Promise<{ entry: ModLibraryEntry; stored: boolean }> {
    const info = await readModInfo(sourcePath);
    const sha = sha256(await readFile(sourcePath));
    const existing = await this.get(info.id);
    if (existing !== undefined && this.jarsOf(existing).some((j) => j.sha256 === sha)) {
      return { entry: existing, stored: false };
    }
    return { entry: await this.store(sourcePath, source, jarName, false), stored: true };
  }

  /**
   * `add`, for jar bytes already in hand - an upload, which must be validated
   * before it is written anywhere on this box.
   *
   * `jarName` is only a label: the mod's identity is the `id` in its own
   * `mod.info`, so a caller with no filename to offer (curl, a script) gets one
   * built from that id rather than a refusal.
   */
  async addBytes(
    bytes: Buffer,
    jarName: string | undefined,
    source: ModSource,
  ): Promise<ModLibraryEntry> {
    // Checked before the zip is opened, so an obviously bad name fails without
    // this daemon doing several megabytes of work to find out.
    if (jarName !== undefined) checkJarFilename(jarName);
    const info = await readModInfoFromBytes(bytes, jarName ?? "the uploaded jar");
    const name = jarName ?? `${safeModId(info.id)}.jar`;
    return this.place(info, name, bytes, source, true);
  }

  private async store(
    sourcePath: string,
    source: ModSource,
    jarName: string | undefined,
    promote: boolean,
  ): Promise<ModLibraryEntry> {
    const info = await readModInfo(sourcePath);
    const name = jarName ?? basenameOf(sourcePath);
    checkJarFilename(name);
    return this.place(info, name, await readFile(sourcePath), source, promote);
  }

  /**
   * Writes the jar, then the manifest - in that order, and the order is the
   * point. A crash between the two leaves a jar no manifest entry names, which
   * is inert; the reverse would leave a manifest entry pointing at a jar that
   * does not exist, which is a library that cannot restore what it claims to
   * hold. Nothing is ever removed here.
   */
  private async place(
    info: ModInfo,
    jarName: string,
    bytes: Buffer,
    source: ModSource,
    promote: boolean,
  ): Promise<ModLibraryEntry> {
    const sha = sha256(bytes);
    const folder = join(this.dir, safeModId(info.id));
    await mkdir(folder, { recursive: true });
    const previous = await this.get(info.id);
    const held = previous === undefined ? [] : this.jarsOf(previous);

    // A storage name already used by a *different* jar of this mod must not be
    // written over - that is the whole invariant. Only the library's own copy is
    // renamed; `jar` keeps the name it arrived under, so the disambiguation
    // never reaches the mods folder and the game's log stays readable.
    const taken = new Set(held.filter((j) => j.sha256 !== sha).map((j) => j.file));
    const file = taken.has(jarName) ? disambiguate(jarName, sha) : jarName;
    await writeFile(join(folder, file), bytes);

    const record: ModLibraryJar = {
      jar: jarName,
      file,
      sha256: sha,
      sizeBytes: bytes.length,
      addedAt: new Date().toISOString(),
      source,
    };
    // Which jar stays current, with everything else retained beside it. Re-
    // adding bytes already held collapses onto one record rather than listing
    // the same file twice.
    const others = held.filter((j) => j.sha256 !== sha);
    const promoting = promote || previous === undefined;
    const current = promoting ? record : held[0];
    const superseded = [record, ...others].filter((j) => j.sha256 !== current.sha256);

    // The descriptive fields (name, version, gameVersion, author) describe the
    // CURRENT jar, so they come from `info` only when this jar is becoming the
    // current one. Retaining an old build must not relabel the entry with that
    // old build's version while the library still installs the new one - the
    // manifest would then describe a jar it does not hand out.
    const entry: ModLibraryEntry = promoting
      ? { ...info, ...record, superseded }
      : { ...(previous as ModLibraryEntry), ...current, superseded };
    await this.write([...(await this.load()).filter((m) => m.id !== info.id), entry]);

    // Re-adding bytes already held under a different name collapses two records
    // onto one, which would otherwise leave the old FILE on disk with nothing
    // in the manifest naming it. Nothing is lost - the surviving record has the
    // same hash, so those exact bytes are still here - but a manifest that
    // stops describing its own directory is how a later reader concludes the
    // library is inconsistent.
    const referenced = new Set(this.jarsOf(entry).map((j) => j.file));
    for (const orphan of held.filter((j) => !referenced.has(j.file))) {
      await rm(join(folder, orphan.file), { force: true });
    }
    return entry;
  }

  /**
   * Drops a mod from the library and deletes every jar it held.
   *
   * The one place this class deletes anything, and it only ever runs because
   * somebody named this mod.
   */
  async remove(id: string): Promise<ModLibraryEntry | undefined> {
    const all = await this.load();
    const found = all.find((m) => m.id === id);
    if (found === undefined) return undefined;
    await this.write(all.filter((m) => m.id !== id));
    for (const j of this.jarsOf(found)) await rm(this.jarPath(found, j.file), { force: true });
    return found;
  }

  /**
   * Confirms the library really can hand back the current jar for this id.
   *
   * The manifest is a claim; this checks the file. Reconcile calls it before it
   * copies anything, because "the library has an entry" and "the library can
   * hand over this jar" are different statements.
   */
  async resolve(id: string): Promise<{ entry: ModLibraryEntry; path: string } | undefined> {
    const entry = await this.get(id);
    if (entry === undefined) return undefined;
    const path = this.jarPath(entry);
    try {
      await stat(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Failed to read library jar at ${path}: ${(e as Error).message}`);
    }
    return { entry, path };
  }

  private async write(entries: ModLibraryEntry[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await mkdir(dirname(this.manifestFile), { recursive: true });
    const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));
    // Atomic. This file is the index of jars that exist nowhere else, and a
    // manifest truncated by a crash mid-write makes `load` throw on every call,
    // which makes every start refuse until somebody repairs it by hand.
    await writeJsonDurable(this.manifestFile, sorted);
  }
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** `Mod-1.0.jar` -> `Mod-1.0-a1b2c3d4.jar`, so a second build under one name still fits. */
function disambiguate(jarName: string, sha: string): string {
  return `${jarName.slice(0, -".jar".length)}-${sha.slice(0, 8)}.jar`;
}

/** The last path segment, for either separator. Windows paths reach here. */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}
