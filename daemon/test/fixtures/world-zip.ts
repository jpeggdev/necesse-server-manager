import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";

/**
 * The real contents of `<World>/worldSettings.cfg`, read out of a live world
 * zip.
 *
 * Written as an array of lines with explicit `\t` escapes rather than as a
 * template literal: the indentation is tabs, the round-trip test compares
 * bytes, and a tab that turned into spaces during an edit would make that test
 * assert the wrong thing while still passing. Note what is here besides the
 * fields - trailing commas, `//` comments after values, and the three
 * `rpgskills*` keys, which the RPG Skills mod wrote and the base game knows
 * nothing about.
 */
export const WORLD_SETTINGS_CFG = [
  "WORLDSETTINGS = {",
  "\tallowCheats = false,",
  "\tdifficulty = CLASSIC,",
  "\tdeathPenalty = DROP_MATS,",
  "\traidFrequency = OCCASIONALLY,",
  "\tsurvivalMode = true,",
  "\tplayerHunger = true,",
  "\tdisableMobSpawns = false,",
  "\tforcedPvP = false, // True = players will always have PvP enabled",
  "\tallowOutsideCharacters = true,",
  "\tcreativeMode = true,",
  "\tdisableMobAI = false,",
  "\tcanSettlersDie = false,",
  "\tdayTimeMod = 1.0, // Day time modifier (The higher, the longer day will last, max 10)",
  "\tnightTimeMod = 1.0, // Night time modifier (The higher, the longer night will last, max 10)",
  "\tgameVersion = 1.2.0,",
  "\trpgskillsWorldStackLevel = 1,",
  "\trpgskillsChestSlotUpgradeLevel = 0,",
  "\trpgskillsWelcomeMessageShown = 1",
  "}",
].join("\n");

/** Deterministic filler, so a content hash means something and reruns match. */
function blob(seed: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export interface WorldZipOptions {
  /** Contents of worldSettings.cfg. Defaults to the verified real file. */
  cfg?: string;
  /** Omit the settings entry entirely, for the "this is not an editable world" case. */
  omitSettings?: boolean;
  /**
   * Add explicit directory entries. Real world zips carry 8-10 of them; a zip
   * built purely from file entries has none, which leaves the whole
   * directory-entry half of verification unexercised.
   */
  directoryEntries?: boolean;
  /**
   * Extra incompressible payload, in bytes. Used where a test needs the save to
   * take long enough to still be in flight when a second request arrives.
   */
  bulkBytes?: number;
}

/**
 * Writes a real world zip to `<dir>/<world>.zip` and returns its path.
 *
 * The entry layout mirrors a live save: every entry sits under a folder named
 * after the world, and the payload files are incompressible noise so that
 * "every other entry came through byte for byte" is a claim with teeth. One
 * entry is deliberately stored uncompressed, because a rebuild has to preserve
 * its *contents*, not its compression method, and a test that only ever saw
 * deflated entries would not notice the difference.
 */
export async function makeWorldZip(
  dir: string,
  world: string,
  options: WorldZipOptions = {},
): Promise<string> {
  const zip = new JSZip();
  const put = (name: string, data: Buffer | string, store = false): void => {
    zip.file(`${world}/${name}`, data, {
      createFolders: false,
      date: new Date("2026-07-20T12:00:00Z"),
      ...(store ? { compression: "STORE" as const } : {}),
    });
  };
  if (options.directoryEntries === true) {
    for (const folder of ["", "levels/", "players/"]) {
      zip.file(`${world}/${folder}`, null, { dir: true, createFolders: false });
    }
  }
  if (options.omitSettings !== true) {
    put("worldSettings.cfg", Buffer.from(options.cfg ?? WORLD_SETTINGS_CFG, "utf8"));
  }
  put("world.dat", blob(1, 64 * 1024));
  put("levels/0_0.dat", blob(2, 32 * 1024));
  put("levels/0_1.dat", blob(3, 32 * 1024), true);
  put("players/76561198000000000.dat", blob(4, 4 * 1024));
  if (options.bulkBytes !== undefined) put("bulk.dat", blob(5, options.bulkBytes));

  const path = join(dir, `${world}.zip`);
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  return path;
}
