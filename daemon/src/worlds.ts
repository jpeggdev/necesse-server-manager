import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorldInfo } from "./types.js";

/** The server writes these rolling autosaves itself; they are not selectable worlds. */
const BACKUP = /^LATEST_BACKUP\d+$/i;
const ILLEGAL = new RegExp("[<>:\"/\\\\|?*\\u0000-\\u001f]");

export async function listWorlds(worldsDir: string): Promise<WorldInfo[]> {
  let entries;
  try {
    entries = await readdir(worldsDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Failed to read worlds directory at ${worldsDir}: ${(e as Error).message}`);
    }
    return [];
  }
  const out: WorldInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".zip")) continue;
    const name = e.name.slice(0, -".zip".length);
    if (BACKUP.test(name)) continue;
    const s = await stat(join(worldsDir, e.name));
    out.push({ name, modifiedAt: s.mtime.toISOString(), sizeBytes: s.size });
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * The zip backing a world, or null if no world by that name is there.
 *
 * Resolved through `listWorlds` rather than by joining the caller's string onto
 * `worldsDir`: the returned path is built from a name this module actually saw
 * on disk, so it can only ever address a real world file, and the server's own
 * LATEST_BACKUP saves stay excluded here exactly as they are from the list.
 * Matching is case-insensitive because Windows is.
 */
export async function worldZipPath(worldsDir: string, name: string): Promise<string | null> {
  if (!isValidWorldName(name)) return null;
  const target = name.toLowerCase();
  const found = (await listWorlds(worldsDir)).find((w) => w.name.toLowerCase() === target);
  return found === undefined ? null : join(worldsDir, `${found.name}.zip`);
}

export async function worldExists(worldsDir: string, name: string): Promise<boolean> {
  return (await worldZipPath(worldsDir, name)) !== null;
}

export function isValidWorldName(name: string): boolean {
  if (name.trim().length === 0) return false;
  if (name === "." || name === "..") return false;
  return !ILLEGAL.test(name);
}
