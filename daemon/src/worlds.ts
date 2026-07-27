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
  } catch {
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

export async function worldExists(worldsDir: string, name: string): Promise<boolean> {
  const target = name.toLowerCase();
  return (await listWorlds(worldsDir)).some((w) => w.name.toLowerCase() === target);
}

export function isValidWorldName(name: string): boolean {
  if (name.trim().length === 0) return false;
  if (name === "." || name === "..") return false;
  return !ILLEGAL.test(name);
}
