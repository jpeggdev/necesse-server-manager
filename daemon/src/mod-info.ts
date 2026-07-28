import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { MOD_INFO_FORMAT, WorldSettingsFile } from "./world-settings-file.js";
import type { ModInfo } from "./types.js";

/**
 * Reading `mod.info` out of a Necesse mod jar.
 *
 * Every mod jar carries one at its root, in the same `key = value,` format as
 * `worldSettings.cfg` (see `world-settings-file.ts`, whose parser this reuses):
 *
 * ```
 * {
 * 	id = gagadoliano.summonerexpansion,
 * 	name = Summoner Expansion,
 * 	version = 7.7,
 * 	gameVersion = 1.2.0,
 * 	author = Gagadoliano,
 * 	description = A summoner expansion mod,
 * 	clientside = false
 * }
 * ```
 *
 * `id` is this feature's whole notion of identity. It is what the game records
 * in `modlist.data`, it survives a version bump that renames the jar, and it is
 * the same string whether the jar came from the workshop or from an upload - so
 * the same mod arriving by two routes unifies instead of duplicating. A jar
 * with no parseable `mod.info` carrying an `id` is therefore not a Necesse mod
 * at all, and nothing downstream will store, install or set it.
 */

/** The entry's name at the jar's root. Matched case-insensitively; nothing else is looked at. */
const MOD_INFO_ENTRY = "mod.info";

/**
 * A jar that is not a Necesse mod, with the reason. Its own type because the
 * upload route turns it into a 400 naming what was wrong, while a failure to
 * *read* the file at all stays an ordinary error and reaches the client as a
 * 500 - the two must not be indistinguishable.
 */
export class NotAModJarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAModJarError";
  }
}

/** The keys this daemon reads. Everything else in the file is left where it is. */
const REQUIRED = "id";

/**
 * Parses `mod.info`'s text.
 *
 * `what` names the jar it came from, so every message points at a file the
 * operator can find rather than at "mod.info", of which there is one per mod.
 */
export function parseModInfo(text: string, what: string): ModInfo {
  let file: WorldSettingsFile;
  try {
    file = WorldSettingsFile.parse(text, MOD_INFO_FORMAT);
  } catch (e) {
    throw new NotAModJarError(`${what} has a mod.info this daemon cannot read: ${(e as Error).message}`);
  }
  const id = (file.get(REQUIRED) ?? "").trim();
  if (id.length === 0) {
    throw new NotAModJarError(
      `${what} has a mod.info with no "id" line, so there is no mod identity to file it under. ` +
        `Every Necesse mod declares one; this is not a Necesse mod.`,
    );
  }
  const field = (key: string): string => (file.get(key) ?? "").trim();
  return {
    id,
    // Falling back to the id rather than to "" or to the filename: a name is
    // only ever shown to a person, and the id is the one string that is
    // certainly there and certainly identifies the right mod.
    name: field("name").length > 0 ? field("name") : id,
    version: field("version"),
    gameVersion: field("gameVersion"),
    author: field("author"),
    // Anything but a literal `true` is false, which is how the game's own
    // parser reads it. A missing line means false.
    clientside: field("clientside").toLowerCase() === "true",
  };
}

/** Reads `mod.info` out of jar bytes already in hand. `what` names the jar for messages. */
export async function readModInfoFromBytes(bytes: Buffer, what: string): Promise<ModInfo> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (e) {
    throw new NotAModJarError(`${what} is not a readable jar: ${(e as Error).message}`);
  }
  const matches = Object.entries(zip.files).filter(
    ([name, entry]) => !entry.dir && name.toLowerCase() === MOD_INFO_ENTRY,
  );
  if (matches.length === 0) {
    throw new NotAModJarError(
      `${what} contains no mod.info at its root, so it is not a Necesse mod jar. ` +
        `Entries seen: ${Object.keys(zip.files).length}.`,
    );
  }
  const raw = await matches[0][1].async("nodebuffer");
  return parseModInfo(raw.toString("utf8"), what);
}

/**
 * Reads `mod.info` out of a jar on disk.
 *
 * A missing file surfaces as the raw ENOENT, so a caller can tell "that jar is
 * gone" from "that jar is not a mod"; everything else about the *contents* is a
 * NotAModJarError naming what was wrong with it.
 */
export async function readModInfo(jarPath: string): Promise<ModInfo> {
  const bytes = await readFile(jarPath);
  return readModInfoFromBytes(bytes, jarPath);
}

/**
 * A mod id, reduced to something that is safe as a single Windows path segment
 * and still recognisable.
 *
 * Real ids (`gagadoliano.summonerexpansion`) already are one, and pass through
 * untouched, which is what makes the library browsable by hand. Anything else -
 * a mod that ships an id with a slash, a `..`, a colon, a reserved device name,
 * or one that differs from another only by case, all of which reach here from
 * an uploaded jar - gets a hash of the exact id appended, so the mapping stays
 * injective: two different ids can never land in one folder and quietly
 * overwrite each other's jar.
 */
const PLAIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/;

export function safeModId(id: string): string {
  if (id === id.toLowerCase() && PLAIN_ID.test(id) && !RESERVED.test(id) && !id.endsWith(".")) {
    return id;
  }
  const stem = id.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^[^a-z0-9]+/, "").slice(0, 40);
  const hash = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 12);
  return `${stem.length > 0 ? stem : "mod"}-${hash}`;
}

/**
 * Windows-illegal characters, plus the separators, plus anything a shell or a
 * path resolver would read as structure. A jar filename crosses the API from a
 * LAN client with no authentication, so it is checked rather than trusted -
 * `basename` alone is not enough, because it would silently turn
 * `..\..\Server.jar` into `Server.jar` and store it under a name nobody asked
 * for instead of refusing.
 */
const ILLEGAL_JAR_NAME = new RegExp("[<>:\"/\\\\|?*\\u0000-\\u001f]");

/** Throws unless `name` is a plain `<something>.jar` filename and nothing more. */
export function checkJarFilename(name: string): void {
  if (name.trim().length === 0) throw new NotAModJarError("A jar filename may not be empty.");
  if (name.length > 200) {
    throw new NotAModJarError(`Jar filename is too long (${name.length} characters, limit 200).`);
  }
  if (!name.toLowerCase().endsWith(".jar")) {
    throw new NotAModJarError(`Jar filename ${JSON.stringify(name)} does not end in .jar.`);
  }
  if (ILLEGAL_JAR_NAME.test(name) || name.includes("..")) {
    throw new NotAModJarError(
      `Jar filename ${JSON.stringify(name)} is not a plain filename. It must name a file, not a path.`,
    );
  }
  const stem = name.slice(0, -".jar".length);
  if (stem.trim().length === 0) {
    throw new NotAModJarError(`Jar filename ${JSON.stringify(name)} is only an extension.`);
  }
  // `CON.jar` does not open a file on Windows, it opens the console device -
  // the extension makes no difference to that, so it has to be refused by name.
  if (RESERVED.test(stem.toLowerCase())) {
    throw new NotAModJarError(
      `Jar filename ${JSON.stringify(name)} uses a reserved Windows device name, which cannot be ` +
        `a file on this box.`,
    );
  }
}
