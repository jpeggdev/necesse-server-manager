import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import JSZip from "jszip";
import { WorldSettingsFile } from "./world-settings-file.js";

/**
 * Reading and rewriting `worldSettings.cfg` inside a world zip.
 *
 * A world zip is the only copy of somebody's save. Everything in this module is
 * arranged around one rule: the original file is not touched until a complete
 * replacement has been built somewhere else, read back off disk, and proved
 * entry-for-entry and byte-for-byte identical to the original apart from the
 * one file being edited. If any of that fails the original is still exactly
 * where it was, and a timestamped copy of it exists besides.
 *
 * Zip support comes from `jszip`: it is the most widely used pure-JavaScript
 * zip implementation, it has no native build step (this daemon runs on a
 * Windows box with no toolchain), it reads and writes in one library, and it
 * ships its own TypeScript types. Working fully in memory is fine at the sizes
 * involved - a real world here is about 12MB.
 */

/** The settings file's name inside the zip, under the world-name folder. */
const SETTINGS_BASENAME = "worldsettings.cfg";

/** Where a replaced zip's predecessor is kept. A directory, so `listWorlds` - which
 *  only looks at files - can never mistake a backup for a world. */
export const BACKUP_DIR_NAME = "settings-backups";

/**
 * How many backups of one world are kept. Every edit leaves a full copy of the
 * zip, so at ~12MB a world this grows without bound if nothing prunes it.
 * Deletion is the one thing this feature does that destroys data on purpose,
 * so every removal is logged by name and only ever touches files this feature
 * wrote, in its own subdirectory, matching its own naming exactly.
 */
export const BACKUP_RETENTION = 10;

/**
 * What follows `<world>-` in a name this module wrote: the timestamp, then the
 * random tail that stops two backups from ever landing on one name. Nothing
 * else in the backup directory is a candidate for pruning, whoever put it
 * there.
 */
const BACKUP_TAIL = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}\.zip$/;

export type WorldSettingsErrorKind =
  /** The zip opened, but carries no worldSettings.cfg, or more than one. */
  | "missing-entry"
  /** The zip, or the settings file in it, could not be read or made sense of. */
  | "unreadable"
  /** The rebuilt zip failed verification. The original was left alone. */
  | "verify-failed";

export class WorldSettingsError extends Error {
  constructor(
    message: string,
    readonly kind: WorldSettingsErrorKind,
  ) {
    super(message);
    this.name = "WorldSettingsError";
  }
}

/** How the replacement zip is serialized. Injectable only so a test can hand back a
 *  corrupt build and prove verification is what protects the original. */
export type ZipBuilder = (zip: JSZip) => Promise<Buffer>;

const buildZip: ZipBuilder = (zip) =>
  zip.generateAsync({
    type: "nodebuffer",
    // Entries already deflated in the source are re-used as-is by jszip; this
    // only decides what happens to anything stored uncompressed. Never STORE,
    // which would inflate a 12MB world to its uncompressed size.
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

export interface SaveResult {
  /** Absolute path of the copy taken of the original, before it was replaced. */
  backupPath: string;
}

export interface OpenWorldSettings {
  /** The entry as the zip spells it, e.g. `Tulsa What/worldSettings.cfg`. */
  entryName: string;
  /** Mutate this, then call `save`. */
  file: WorldSettingsFile;
  /**
   * Rebuilds the zip with whatever `file` now says, verifies the rebuild, backs
   * the original up, and only then replaces it. Callers that have nothing to
   * change should not call this at all: it always writes.
   */
  save(build?: ZipBuilder): Promise<SaveResult>;
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Writes a file and does not come back until the bytes are on the disk.
 *
 * A resolved `writeFile` means the data reached the OS page cache. It says
 * nothing about the platter. Without the fsync below, a power loss or a BSOD
 * in the seconds around a save can leave NTFS having journalled the rename
 * while the replacement's data blocks were never written - and the backup,
 * written the same way, is just as unflushed. That is the one sequence that
 * can leave a world with neither a good original nor a good replacement. A
 * process crash was always survivable; hardware loss was not.
 *
 * This is not redundant with the write above it and must not be removed as
 * such. (There is no matching fsync of the directory: Windows cannot open one
 * for syncing, so the rename's own metadata durability is left to the NTFS
 * journal, which is what orders it against the data writes this forces.)
 */
async function writeDurable(path: string, data: Buffer): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Every non-directory entry's name mapped to the hash of its *uncompressed* bytes. */
async function hashEntries(zip: JSZip): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    out.set(name, sha256(await entry.async("nodebuffer")));
  }
  return out;
}

/** Directory entry names, which must survive a rebuild as exactly as file entries. */
const dirNames = (zip: JSZip): Set<string> =>
  new Set(Object.entries(zip.files).filter(([, e]) => e.dir).map(([name]) => name));

async function loadZip(bytes: Buffer, what: string): Promise<JSZip> {
  try {
    // checkCRC32 turns a silently corrupt entry into a thrown error. It costs a
    // pass over the data that is being decompressed anyway, and the alternative
    // is writing corruption forward into the replacement zip.
    return await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch (e) {
    throw new WorldSettingsError(`${what} is not a readable zip: ${(e as Error).message}`, "unreadable");
  }
}

function findSettingsEntry(zip: JSZip, zipPath: string): string {
  const matches = Object.entries(zip.files)
    .filter(([name, entry]) => !entry.dir && basename(name).toLowerCase() === SETTINGS_BASENAME)
    .map(([name]) => name);
  if (matches.length === 0) {
    throw new WorldSettingsError(
      `${zipPath} contains no worldSettings.cfg. Entries seen: ${Object.keys(zip.files).length}.`,
      "missing-entry",
    );
  }
  if (matches.length > 1) {
    throw new WorldSettingsError(
      `${zipPath} contains more than one worldSettings.cfg (${matches.join(", ")}). Refusing to ` +
        `guess which one the game reads.`,
      "missing-entry",
    );
  }
  return matches[0];
}

/**
 * Opens a world zip and parses its settings file.
 *
 * A missing zip surfaces as the raw ENOENT so a caller can tell "this world is
 * gone" from "this world is broken"; everything else is a WorldSettingsError
 * carrying which of the two it was.
 */
export async function openWorldSettings(zipPath: string): Promise<OpenWorldSettings> {
  let original: Buffer;
  try {
    original = await readFile(zipPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw e;
    throw new WorldSettingsError(`Failed to read ${zipPath}: ${(e as Error).message}`, "unreadable");
  }

  const zip = await loadZip(original, zipPath);
  const entryName = findSettingsEntry(zip, zipPath);
  const entryBytes = await zip.files[entryName].async("nodebuffer");
  const text = entryBytes.toString("utf8");

  // Everything downstream works on the decoded string and writes it back as
  // UTF-8, so a file whose bytes do not survive that trip must be refused
  // rather than quietly re-encoded. In practice the game writes ASCII and this
  // never fires; it is here because "never fires" is an assumption, and the
  // cost of it being wrong is a corrupted save.
  if (!Buffer.from(text, "utf8").equals(entryBytes)) {
    throw new WorldSettingsError(
      `${entryName} in ${zipPath} is not valid UTF-8, so it cannot be edited without changing ` +
        `bytes this daemon does not understand. Refusing to touch it.`,
      "unreadable",
    );
  }

  let file: WorldSettingsFile;
  try {
    file = WorldSettingsFile.parse(text);
  } catch (e) {
    throw new WorldSettingsError(`${entryName} in ${zipPath}: ${(e as Error).message}`, "unreadable");
  }

  const save = async (build: ZipBuilder = buildZip): Promise<SaveResult> => {
    const newText = file.text();
    const newBytes = Buffer.from(newText, "utf8");
    const originalEntries = await hashEntries(zip);
    const originalDirs = dirNames(zip);

    // Replaces the one entry and nothing else. `createFolders: false` matters:
    // jszip would otherwise invent folder entries for the world-name prefix
    // that the original zip never had, and the verification below - which
    // demands the entry set match exactly - would rightly refuse the result.
    zip.file(entryName, newBytes, {
      createFolders: false,
      // The entry's own timestamp is left where the game put it. This edit
      // changes one value in one file; it is not an occasion to restate the
      // zip's metadata.
      date: zip.files[entryName].date,
    });

    // A uuid, not a timestamp: `stamp()` has millisecond resolution and two
    // saves close enough together would name the same temp file and interleave
    // inside it. The route-level interlock is what actually serializes writes;
    // this is the second line of defence, so that anything which ever slips
    // past that interlock still cannot corrupt another writer's build.
    const tempPath = join(dirname(zipPath), `.${basename(zipPath)}.${randomUUID()}.tmp`);
    let placed = false;
    try {
      await writeDurable(tempPath, await build(zip));

      // Read the replacement back off disk rather than trusting the buffer
      // that was just written: what matters is that the file now sitting on
      // this disk is complete and correct, which is a different claim from
      // "the bytes we handed the OS were".
      const rebuilt = await loadZip(await readFile(tempPath), `The rebuilt copy of ${zipPath}`);
      await verifyRebuild(rebuilt, originalEntries, originalDirs, entryName, newBytes, zipPath);

      // Only now, with a verified replacement in hand, is anything allowed to
      // happen to the original - and the backup goes down first.
      const backupPath = await writeBackup(zipPath, original);

      await rename(tempPath, zipPath);
      placed = true;

      // After the world is safely replaced, never before: a prune that failed
      // must not be able to fail the save, and a prune that ran must not be
      // able to remove the backup for a replacement that never happened.
      try {
        await pruneBackups(dirname(backupPath), basename(zipPath, ".zip"));
      } catch (e) {
        console.error(`Failed to prune old backups in ${dirname(backupPath)}: ${(e as Error).message}`);
      }
      return { backupPath };
    } finally {
      // On every failure path the temp file goes and the original is still
      // whole. `rename` consumed it on the success path.
      if (!placed) await rm(tempPath, { force: true });
    }
  };

  return { entryName, file, save };
}

async function verifyRebuild(
  rebuilt: JSZip,
  originalEntries: Map<string, string>,
  originalDirs: Set<string>,
  entryName: string,
  newBytes: Buffer,
  zipPath: string,
): Promise<void> {
  const fail = (why: string): never => {
    throw new WorldSettingsError(
      `The rebuilt copy of ${zipPath} failed verification (${why}). The original was left ` +
        `untouched and nothing was replaced.`,
      "verify-failed",
    );
  };

  const rebuiltDirs = dirNames(rebuilt);
  for (const d of originalDirs) if (!rebuiltDirs.has(d)) fail(`directory entry "${d}" is missing`);
  for (const d of rebuiltDirs) if (!originalDirs.has(d)) fail(`it gained a directory entry "${d}"`);

  const rebuiltEntries = await hashEntries(rebuilt);
  for (const name of originalEntries.keys()) {
    if (!rebuiltEntries.has(name)) fail(`entry "${name}" is missing`);
  }
  for (const name of rebuiltEntries.keys()) {
    if (!originalEntries.has(name)) fail(`it gained an entry "${name}"`);
  }
  for (const [name, hash] of originalEntries) {
    if (name === entryName) continue;
    if (rebuiltEntries.get(name) !== hash) fail(`entry "${name}" no longer has its original contents`);
  }
  if (rebuiltEntries.get(entryName) !== sha256(newBytes)) {
    fail(`entry "${entryName}" is not the text that was meant to be written`);
  }
}

/**
 * Writes the pre-edit zip aside and proves it landed by reading it back and
 * hashing it. "Confirmed written" has to mean read back and compared: a
 * successful write says the call returned, not that a complete and correct
 * file exists, and this copy is the only thing standing between a bad
 * replacement and a lost world.
 *
 * The two checks answer different questions and both are needed. The read-back
 * proves the bytes are the right bytes - but it is served from the page cache,
 * so it proves nothing about the disk. `writeDurable`'s fsync is what makes
 * them survive a power cut.
 */
async function writeBackup(zipPath: string, original: Buffer): Promise<string> {
  const dir = join(dirname(zipPath), BACKUP_DIR_NAME);
  await mkdir(dir, { recursive: true });
  // Timestamp first so a plain name sort is an age sort, then a random tail so
  // two backups can never collide on a name and silently overwrite each other.
  const backupPath = join(
    dir,
    `${basename(zipPath, ".zip")}-${stamp()}-${randomUUID().slice(0, 8)}.zip`,
  );
  await writeDurable(backupPath, original);
  const readBack = await readFile(backupPath);
  if (sha256(readBack) !== sha256(original)) {
    // Deliberately not deleted: something is wrong with this disk, and a
    // suspect copy is easier to reason about later than a vanished one.
    throw new WorldSettingsError(
      `The backup written to ${backupPath} does not match the original ${zipPath} when read ` +
        `back. Nothing was replaced.`,
      "verify-failed",
    );
  }
  return backupPath;
}

/**
 * Keeps the most recent `BACKUP_RETENTION` backups of one world and deletes the
 * rest, naming every file it removes.
 *
 * This is the only place the feature destroys data on purpose, so it is
 * deliberately timid about what it will touch: only files inside its own
 * backup directory, only ones whose name matches what `writeBackup` produces
 * exactly, and only for the world being saved. Anything else in that folder -
 * a copy somebody made by hand, another world's backups - is not a candidate,
 * and a silent prune is how a person loses the copy they were counting on.
 */
async function pruneBackups(dir: string, worldBase: string): Promise<void> {
  const prefix = `${worldBase}-`;
  const entries = await readdir(dir, { withFileTypes: true });
  const mine = entries
    .filter(
      (e) => e.isFile() && e.name.startsWith(prefix) && BACKUP_TAIL.test(e.name.slice(prefix.length)),
    )
    .map((e) => e.name)
    // The timestamp leads the name, so sorting by name sorts by age.
    .sort()
    .reverse();

  for (const name of mine.slice(BACKUP_RETENTION)) {
    const path = join(dir, name);
    await rm(path);
    console.log(
      `Deleted world settings backup ${path}: keeping the ${BACKUP_RETENTION} most recent ` +
        `backups of "${worldBase}".`,
    );
  }
}
