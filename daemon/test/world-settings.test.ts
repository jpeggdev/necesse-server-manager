import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
  openWorldSettings,
  WorldSettingsError,
  BACKUP_DIR_NAME,
  type ZipBuilder,
} from "../src/world-settings.js";
import { makeWorldZip, WORLD_SETTINGS_CFG } from "./fixtures/world-zip.js";

/**
 * These run against real zip files written to a real temp directory. Nothing
 * about the zip layer is mocked: the thing being proved is that a world zip on
 * a disk survives, and a stubbed archive cannot say anything about that.
 */

const WORLD = "Tulsa What";

let dir: string;
let zipPath: string;

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** Every entry of a zip on disk, name -> hash of its uncompressed bytes. */
async function entriesOf(path: string): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(await readFile(path), { checkCRC32: true, createFolders: false });
  const out = new Map<string, string>();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    out.set(name, sha(await entry.async("nodebuffer")));
  }
  return out;
}

async function entryText(path: string, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(path), { checkCRC32: true, createFolders: false });
  const entry = zip.files[name];
  return (await entry.async("nodebuffer")).toString("utf8");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necesse-worldsettings-"));
  zipPath = await makeWorldZip(dir, WORLD);
});

describe("openWorldSettings", () => {
  it("finds the settings file under the world-name folder and parses it", async () => {
    const open = await openWorldSettings(zipPath);
    expect(open.entryName).toBe(`${WORLD}/worldSettings.cfg`);
    expect(open.file.text()).toBe(WORLD_SETTINGS_CFG);
  });

  it("reports a zip with no worldSettings.cfg as missing rather than broken", async () => {
    const other = await makeWorldZip(dir, "Empty World", { omitSettings: true });
    await expect(openWorldSettings(other)).rejects.toMatchObject({
      kind: "missing-entry",
      message: /contains no worldSettings\.cfg/,
    });
  });

  it("reports a file that is not a zip as unreadable", async () => {
    const junk = join(dir, "Junk.zip");
    await writeFile(junk, Buffer.from("this is not a zip"));
    await expect(openWorldSettings(junk)).rejects.toMatchObject({ kind: "unreadable" });
  });

  it("passes a missing zip through as ENOENT, distinct from a real failure", async () => {
    await expect(openWorldSettings(join(dir, "Nope.zip"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a settings file it cannot parse", async () => {
    const broken = await makeWorldZip(dir, "Broken", { cfg: "nothing = useful\n" });
    await expect(openWorldSettings(broken)).rejects.toMatchObject({
      kind: "unreadable",
      message: /WORLDSETTINGS/,
    });
  });
});

describe("saving a world zip", () => {
  it("replaces the settings entry and leaves every other entry byte-identical", async () => {
    const before = await entriesOf(zipPath);
    const open = await openWorldSettings(zipPath);
    open.file.set("difficulty", "BRUTAL");
    await open.save();

    const after = await entriesOf(zipPath);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [name, hash] of before) {
      if (name === open.entryName) continue;
      expect(after.get(name), name).toBe(hash);
    }
    expect(await entryText(zipPath, open.entryName)).toBe(
      WORLD_SETTINGS_CFG.replace("difficulty = CLASSIC", "difficulty = BRUTAL"),
    );
  });

  it("keeps mod-written keys through a real rewrite of the zip", async () => {
    const open = await openWorldSettings(zipPath);
    open.file.set("allowCheats", "true");
    await open.save();

    const text = await entryText(zipPath, `${WORLD}/worldSettings.cfg`);
    expect(text).toContain("\trpgskillsWorldStackLevel = 1,");
    expect(text).toContain("\trpgskillsChestSlotUpgradeLevel = 0,");
    expect(text).toContain("\trpgskillsWelcomeMessageShown = 1");
    expect(text).toBe(WORLD_SETTINGS_CFG.replace("allowCheats = false", "allowCheats = true"));
  });

  it("writes a timestamped backup that is byte-identical to the pre-edit zip", async () => {
    const original = await readFile(zipPath);
    const open = await openWorldSettings(zipPath);
    open.file.set("survivalMode", "false");
    const { backupPath } = await open.save();

    expect(backupPath).toContain(BACKUP_DIR_NAME);
    expect(sha(await readFile(backupPath))).toBe(sha(original));
    // The new zip really is new, so the backup is not a copy of the result.
    expect(sha(await readFile(zipPath))).not.toBe(sha(original));
  });

  it("keeps backups out of the worlds directory itself, where they would list as worlds", async () => {
    const open = await openWorldSettings(zipPath);
    open.file.set("playerHunger", "false");
    await open.save();

    const top = await readdir(dir, { withFileTypes: true });
    expect(top.filter((e) => e.isFile()).map((e) => e.name)).toEqual([`${WORLD}.zip`]);
    expect(top.filter((e) => e.isDirectory()).map((e) => e.name)).toEqual([BACKUP_DIR_NAME]);
  });

  it("leaves no temporary file behind on the happy path", async () => {
    const open = await openWorldSettings(zipPath);
    open.file.set("creativeMode", "false");
    await open.save();
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

/*
 * The tests that matter most.
 *
 * The happy path proves the feature works; these prove that when it does not,
 * the world is still there. Each one hands `save` a builder that produces a
 * replacement zip which is wrong in a different way, and asserts the same three
 * things: the call failed loudly, the original file on disk is byte-for-byte
 * what it was, and nothing was left lying around.
 */
describe("a rebuild that fails verification never replaces the original", () => {
  const corruptions: [string, ZipBuilder][] = [
    [
      "an entry has gone missing",
      async (zip) => {
        zip.remove(`${WORLD}/players/76561198000000000.dat`);
        return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      },
    ],
    [
      "an untouched entry's contents changed",
      async (zip) => {
        zip.file(`${WORLD}/world.dat`, Buffer.from("silently different"), { createFolders: false });
        return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      },
    ],
    [
      "an entry appeared that was never in the original",
      async (zip) => {
        zip.file(`${WORLD}/uninvited.dat`, Buffer.from("extra"), { createFolders: false });
        return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      },
    ],
    [
      "the settings entry is not the text that was meant to be written",
      async (zip) => {
        zip.file(`${WORLD}/worldSettings.cfg`, Buffer.from("WORLDSETTINGS = {\n}"), {
          createFolders: false,
        });
        return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      },
    ],
    [
      "the build is truncated",
      async (zip) => {
        const full = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
        return full.subarray(0, Math.floor(full.length / 2));
      },
    ],
    ["the build is not a zip at all", async () => Buffer.from("PK not really")],
  ];

  for (const [what, build] of corruptions) {
    it(`aborts and preserves the world when ${what}`, async () => {
      const original = await readFile(zipPath);
      const open = await openWorldSettings(zipPath);
      open.file.set("difficulty", "HARD");

      await expect(open.save(build)).rejects.toBeInstanceOf(WorldSettingsError);

      // The world is exactly as it was: same bytes, still openable, settings
      // still saying what they said.
      const after = await readFile(zipPath);
      expect(sha(after)).toBe(sha(original));
      expect(await entryText(zipPath, `${WORLD}/worldSettings.cfg`)).toBe(WORLD_SETTINGS_CFG);

      // Nothing half-written was left in the worlds directory, and no backup
      // was taken - the original was never at risk, so there was nothing to
      // back up.
      const left = await readdir(dir);
      expect(left).toEqual([`${WORLD}.zip`]);
    });
  }

  it("names what was wrong instead of failing vaguely", async () => {
    const open = await openWorldSettings(zipPath);
    open.file.set("difficulty", "HARD");
    await expect(
      open.save(async (zip) => {
        zip.remove(`${WORLD}/levels/0_1.dat`);
        return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      }),
    ).rejects.toThrow(/entry "Tulsa What\/levels\/0_1\.dat" is missing[\s\S]*left\s+untouched/);
  });

  it("still refuses when the failure is a corrupt entry rather than a missing one", async () => {
    // CRC checking on the verification read is what catches this: the entry is
    // present and the right length, and only its bytes are wrong.
    const original = await readFile(zipPath);
    const open = await openWorldSettings(zipPath);
    open.file.set("difficulty", "HARD");
    await expect(
      open.save(async (zip) => {
        const full = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
        // Flip a byte well inside the compressed payload of the first entry.
        const copy = Buffer.from(full);
        copy[Math.floor(copy.length / 3)] ^= 0xff;
        return copy;
      }),
    ).rejects.toBeInstanceOf(WorldSettingsError);
    expect(sha(await readFile(zipPath))).toBe(sha(original));
  });
});
