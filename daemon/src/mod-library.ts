import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkJarFilename, readModInfo, readModInfoFromBytes, safeModId } from "./mod-info.js";
import type { ModLibraryEntry, ModSource } from "./types.js";

/**
 * The library: one jar per mod id, kept where nothing else will touch it.
 *
 * The mods folder the game reads is not a safe place to keep anything, because
 * reconciling it to a world's set deletes from it. The library is what makes
 * that deletion reversible: every jar the mods folder has ever held is copied in
 * here first, so a set can be swapped freely and any mod put back. That is the
 * one invariant the whole feature rests on - never delete a jar the library
 * cannot restore - and it is why `add` is the only side effect reconcile is
 * allowed to perform before it prunes.
 *
 * Layout: `<dir>/<safe mod id>/<original filename>.jar`, manifest at
 * `<manifestFile>`. The per-id subfolder keeps the original filename, which is
 * what the game logs and what a person recognises, while making two mods that
 * happen to ship the same jar name impossible to collide.
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

  /** Where this entry's jar is, or would be. */
  jarPath(entry: Pick<ModLibraryEntry, "id" | "jar">): string {
    return join(this.dir, safeModId(entry.id), entry.jar);
  }

  /**
   * Copies a jar on disk into the library, keyed by the id in its own
   * `mod.info`.
   *
   * The jar is read and validated before anything is written, so a file that is
   * not a Necesse mod never reaches the library at all. An id already in the
   * library is replaced: the library holds exactly one jar per id, because two
   * jars for one mod is precisely the state that makes the game load a mod twice.
   */
  async add(sourcePath: string, source: ModSource, jarName?: string): Promise<ModLibraryEntry> {
    const info = await readModInfo(sourcePath);
    const name = jarName ?? basenameOf(sourcePath);
    checkJarFilename(name);
    const size = (await stat(sourcePath)).size;
    const entry: ModLibraryEntry = {
      ...info,
      jar: name,
      source,
      addedAt: new Date().toISOString(),
      sizeBytes: size,
    };
    return this.place(entry, (target) => copyFile(sourcePath, target));
  }

  /**
   * The same, for jar bytes already in hand - an upload, which must be
   * validated before it is written anywhere on this box.
   *
   * `jarName` is only a label: the mod's identity is the `id` in its own
   * `mod.info`, so a caller that has no filename to offer (curl, a script) gets
   * one built from that id rather than a refusal.
   */
  async addBytes(bytes: Buffer, jarName: string | undefined, source: ModSource): Promise<ModLibraryEntry> {
    // Checked before the zip is opened, so an obviously bad name fails without
    // this daemon doing several megabytes of work to find out.
    if (jarName !== undefined) checkJarFilename(jarName);
    const info = await readModInfoFromBytes(bytes, jarName ?? "the uploaded jar");
    const name = jarName ?? `${safeModId(info.id)}.jar`;
    const entry: ModLibraryEntry = {
      ...info,
      jar: name,
      source,
      addedAt: new Date().toISOString(),
      sizeBytes: bytes.length,
    };
    return this.place(entry, (target) => writeFile(target, bytes));
  }

  /**
   * Writes the jar, then the manifest, then removes a superseded jar - in that
   * order, and the order is the point. A crash between the first two leaves a
   * jar no manifest entry names, which is inert; the reverse would leave a
   * manifest entry pointing at a jar that does not exist, which is a library
   * that cannot restore what it claims to hold.
   */
  private async place(
    entry: ModLibraryEntry,
    write: (target: string) => Promise<void>,
  ): Promise<ModLibraryEntry> {
    const folder = join(this.dir, safeModId(entry.id));
    await mkdir(folder, { recursive: true });
    const previous = await this.get(entry.id);
    await write(join(folder, entry.jar));
    await this.write([...(await this.load()).filter((m) => m.id !== entry.id), entry]);
    if (previous !== undefined && previous.jar !== entry.jar) {
      await rm(this.jarPath(previous), { force: true });
    }
    return entry;
  }

  /** Drops a mod from the library and deletes its jar. */
  async remove(id: string): Promise<ModLibraryEntry | undefined> {
    const all = await this.load();
    const found = all.find((m) => m.id === id);
    if (found === undefined) return undefined;
    await this.write(all.filter((m) => m.id !== id));
    await rm(this.jarPath(found), { force: true });
    return found;
  }

  /**
   * Confirms the library really can hand back a jar for this id.
   *
   * The manifest is a claim; this checks the file. Reconcile calls it before it
   * deletes anything, because "the library has an entry" and "the library can
   * restore this mod" are different statements and only the second one licenses
   * a delete.
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
    await writeFile(this.manifestFile, JSON.stringify(sorted, null, 2), "utf8");
  }
}

/** The last path segment, for either separator. Windows paths reach here. */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1];
}
