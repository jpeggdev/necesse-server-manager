import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";

/**
 * Real mod jars, built in a temp directory.
 *
 * These are actual zip files with an actual `mod.info` entry, not stubs and not
 * a mocked zip layer. The whole feature turns on reading a real jar's real
 * `mod.info`, so a test that mocked the zip reader would prove that the mock
 * works and nothing about whether a jar off the workshop parses.
 *
 * `MOD_INFO_SUMMONER_EXPANSION` below is the verbatim `mod.info` extracted from
 * `SummonerExpansion-1.2.0-7.7.jar` - the hand-placed jar that is sitting in the
 * live server's mods folder right now, and the reason this feature exists. Tab
 * indentation, trailing commas, no trailing newline: evidence, not a guess. Do
 * not tidy it.
 */
export const MOD_INFO_SUMMONER_EXPANSION = [
  "{",
  "\tid = gagadoliano.summonerexpansion,",
  "\tname = Summoner Expansion,",
  "\tversion = 7.7,",
  "\tgameVersion = 1.2.0,",
  "\tauthor = Gagadoliano,",
  "\tdescription = A summoner expansion mod,",
  "\tclientside = false",
  "}",
].join("\n");

export interface ModInfoFields {
  id?: string;
  name?: string;
  version?: string;
  gameVersion?: string;
  author?: string;
  description?: string;
  clientside?: boolean;
}

/** A `mod.info` in the game's own format: tabs, trailing commas, no final newline. */
export function modInfoText(fields: ModInfoFields): string {
  const lines: string[] = [];
  const put = (key: string, value: string | undefined): void => {
    if (value !== undefined) lines.push(`\t${key} = ${value}`);
  };
  put("id", fields.id);
  put("name", fields.name);
  put("version", fields.version);
  put("gameVersion", fields.gameVersion);
  put("author", fields.author);
  put("description", fields.description);
  put("clientside", fields.clientside === undefined ? undefined : String(fields.clientside));
  return `{\n${lines.join(",\n")}\n}`;
}

export interface ModJarOptions {
  /** Raw `mod.info` text, in place of one built from `fields`. */
  info?: string;
  /** Omit `mod.info` entirely: a jar that is not a Necesse mod. */
  omitInfo?: boolean;
  /** Extra payload, so two jars for the same mod differ in bytes as well as name. */
  filler?: string;
}

/** Builds a jar's bytes. Real zip, real entries. */
export async function modJarBytes(
  fields: ModInfoFields,
  options: ModJarOptions = {},
): Promise<Buffer> {
  const zip = new JSZip();
  if (options.omitInfo !== true) {
    zip.file("mod.info", options.info ?? modInfoText(fields), { createFolders: false });
  }
  // A real mod jar is mostly classes; carrying some means the mod.info is found
  // among other entries rather than as the only one there is.
  zip.file("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\n", { createFolders: false });
  zip.file(`mod/${fields.id ?? "anon"}/Main.class`, options.filler ?? "\xca\xfe\xba\xbe classes", {
    createFolders: false,
  });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Writes a jar to `<dir>/<filename>` and returns its path. */
export async function makeModJar(
  dir: string,
  filename: string,
  fields: ModInfoFields,
  options: ModJarOptions = {},
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, await modJarBytes(fields, options));
  return path;
}

/** A jar with no `mod.info` at all: a perfectly good zip that is not a Necesse mod. */
export async function makeNonModJar(dir: string, filename: string): Promise<string> {
  return makeModJar(dir, filename, { id: "irrelevant" }, { omitInfo: true });
}
