import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import JSZip from "jszip";
import {
  openWorldSettings,
  WorldSettingsError,
  BACKUP_DIR_NAME,
  BACKUP_RETENTION,
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

/** Directory entry names, which a rebuild has to preserve as exactly as files. */
async function dirsOf(path: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(await readFile(path), { createFolders: false });
  return Object.entries(zip.files)
    .filter(([, e]) => e.dir)
    .map(([name]) => name)
    .sort();
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
 * Real world zips carry 8-10 explicit directory entries. Every fixture above
 * has none, so until these existed the whole directory half of verification had
 * never run against anything.
 */
describe("directory entries", () => {
  let dirZip: string;

  beforeEach(async () => {
    dirZip = await makeWorldZip(dir, "Dir World", { directoryEntries: true });
  });

  it("carries them through a rebuild unchanged", async () => {
    const before = await dirsOf(dirZip);
    expect(before.length).toBeGreaterThan(0);

    const open = await openWorldSettings(dirZip);
    open.file.set("difficulty", "HARD");
    await open.save();

    expect(await dirsOf(dirZip)).toEqual(before);
    expect(await entryText(dirZip, "Dir World/worldSettings.cfg")).toBe(
      WORLD_SETTINGS_CFG.replace("difficulty = CLASSIC", "difficulty = HARD"),
    );
  });

  it("refuses a rebuild that dropped one", async () => {
    const original = await readFile(dirZip);
    const open = await openWorldSettings(dirZip);
    open.file.set("difficulty", "HARD");
    await expect(
      open.save(async (zip) => {
        zip.remove("Dir World/players/");
        return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      }),
    ).rejects.toThrow(/directory entry "Dir World\/players\/" is missing/);
    expect(sha(await readFile(dirZip))).toBe(sha(original));
  });

  it("refuses a rebuild that invented one", async () => {
    const original = await readFile(dirZip);
    const open = await openWorldSettings(dirZip);
    open.file.set("difficulty", "HARD");
    await expect(
      open.save(async (zip) => {
        zip.file("Dir World/uninvited/", null, { dir: true, createFolders: false });
        return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      }),
    ).rejects.toThrow(/gained a directory entry/);
    expect(sha(await readFile(dirZip))).toBe(sha(original));
  });
});

/*
 * Pruning is the one thing this feature does that destroys data on purpose, so
 * what it will and will not touch is pinned tightly, and every deletion has to
 * announce itself.
 */
describe("backup pruning", () => {
  const backupDir = (): string => join(dir, BACKUP_DIR_NAME);

  /** A name shaped exactly like one `writeBackup` produces. */
  const backupName = (base: string, n: number): string =>
    `${base}-2020-01-${String(n).padStart(2, "0")}T00-00-00-000Z-0000000${(n % 10).toString(16)}.zip`;

  const save = async (value: string): Promise<string> => {
    const open = await openWorldSettings(zipPath);
    open.file.set("difficulty", value);
    return (await open.save()).backupPath;
  };

  it("keeps only the most recent backups and names every file it deletes", async () => {
    await mkdir(backupDir(), { recursive: true });
    for (let n = 1; n <= 15; n++) {
      await writeFile(join(backupDir(), backupName(WORLD, n)), `old backup ${n}`);
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const fresh = await save("HARD");

      const left = (await readdir(backupDir())).sort();
      expect(left).toHaveLength(BACKUP_RETENTION);
      // The one just written survives, and so do the newest of the old ones.
      expect(left).toContain(basename(fresh));
      expect(left).toContain(backupName(WORLD, 15));
      // The oldest are gone...
      expect(left).not.toContain(backupName(WORLD, 1));
      expect(left).not.toContain(backupName(WORLD, 6));
      // ...and every one of them said so.
      const deleted = log.mock.calls.map((c) => String(c[0]));
      expect(deleted).toHaveLength(16 - BACKUP_RETENTION);
      for (const line of deleted) expect(line).toMatch(/Deleted world settings backup .+\.zip/);
      expect(deleted.join("\n")).toContain(backupName(WORLD, 1));
    } finally {
      log.mockRestore();
    }
  });

  it("never touches a file it did not write", async () => {
    await mkdir(backupDir(), { recursive: true });
    const bystanders = [
      "keep-me.txt",
      `${WORLD}.zip`,
      `${WORLD}-not-a-stamp.zip`,
      `${WORLD}-2020-01-01T00-00-00-000Z-0000000a.zip.bak`,
      "Some Other World-2020-01-01T00-00-00-000Z-0000000b.zip",
    ];
    for (const name of bystanders) await writeFile(join(backupDir(), name), "not mine");
    for (let n = 1; n <= 15; n++) {
      await writeFile(join(backupDir(), backupName(WORLD, n)), `old backup ${n}`);
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await save("HARD");
    } finally {
      log.mockRestore();
    }

    const left = await readdir(backupDir());
    for (const name of bystanders) expect(left, name).toContain(name);
  });

  it("gives two saves two distinct backups rather than overwriting one", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const first = await save("HARD");
      const second = await save("BRUTAL");
      expect(first).not.toBe(second);
      expect((await readdir(backupDir())).sort()).toEqual([basename(first), basename(second)].sort());
    } finally {
      log.mockRestore();
    }
  });

  it("does not prune when there is nothing to prune", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await save("HARD");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
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
