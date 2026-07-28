import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Writing a file so that a crash cannot leave a half-written one behind.
 *
 * Extracted from `world-settings.ts`, which needed it first and still uses it:
 * a resolved `writeFile` means the data reached the OS page cache, not the
 * platter, so a power loss or a BSOD in the seconds around a save can leave NTFS
 * having journalled the write while the data blocks were never written.
 */

/**
 * Writes a file and does not come back until the bytes are on the disk.
 *
 * This is not redundant with the write inside it and must not be simplified to
 * a plain `writeFile`. (There is no matching fsync of the directory: Windows
 * cannot open one for syncing, so a rename's metadata durability is left to the
 * NTFS journal, which is what orders it against the data writes this forces.)
 */
export async function writeDurable(path: string, data: Buffer): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Replaces a JSON file atomically: build it beside the original, flush it, then
 * rename over the top. A reader either sees the whole old file or the whole new
 * one, never a truncated one.
 *
 * This matters for the two files that index jars which exist nowhere else.
 * `mod-library.json` truncated by a crash mid-write makes `ModLibrary.load()`
 * throw on every call, which makes every start refuse, and only a hand repair
 * gets the daemon working again - while the jars themselves were never in
 * danger. The failure being recoverable-but-only-by-hand is exactly what a
 * rename avoids: the temp file is discarded and the previous manifest is still
 * whole.
 *
 * The temp name carries a uuid rather than a timestamp so two writers can never
 * pick the same one and interleave inside it, and it is dot-prefixed so anything
 * scanning the directory can tell it apart from real content.
 */
export async function writeJsonDurable(path: string, value: unknown): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let placed = false;
  try {
    await writeDurable(temp, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
    await rename(temp, path);
    placed = true;
  } finally {
    // On every failure path the temp file goes and the original is still whole.
    // `rename` consumed it on the success path.
    if (!placed) await rm(temp, { force: true });
  }
}
