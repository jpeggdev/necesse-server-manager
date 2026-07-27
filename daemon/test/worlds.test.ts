import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorlds, worldExists, isValidWorldName } from "../src/worlds.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "necesse-worlds-"));
  await writeFile(join(dir, "Tulsa.zip"), "a");
  await writeFile(join(dir, "Infected Toenail.zip"), "bb");
  await writeFile(join(dir, "LATEST_BACKUP1.zip"), "ccc");
  await writeFile(join(dir, "notes.txt"), "d");
  await mkdir(join(dir, "somedir.zip"));
  await writeFile(join(dir, "LATEST_BACKUP_notes.zip"), "e");
  await writeFile(join(dir, "My LATEST_BACKUP1.zip"), "f");
});

describe("listWorlds", () => {
  it("lists zip files without the extension", async () => {
    const names = (await listWorlds(dir)).map((w) => w.name);
    expect(names).toContain("Tulsa");
    expect(names).toContain("Infected Toenail");
  });

  it("excludes non-zip files and directories", async () => {
    const names = (await listWorlds(dir)).map((w) => w.name);
    expect(names).not.toContain("notes");
    expect(names).not.toContain("somedir");
  });

  it("excludes automatic backups, which are not selectable worlds", async () => {
    const names = (await listWorlds(dir)).map((w) => w.name);
    expect(names).not.toContain("LATEST_BACKUP1");
  });

  it("does not exclude world names that merely resemble a backup name", async () => {
    const names = (await listWorlds(dir)).map((w) => w.name);
    expect(names).toContain("LATEST_BACKUP_notes");
    expect(names).toContain("My LATEST_BACKUP1");
  });

  it("reports size and modified time", async () => {
    const tulsa = (await listWorlds(dir)).find((w) => w.name === "Tulsa");
    expect(tulsa?.sizeBytes).toBe(1);
    expect(Date.parse(tulsa!.modifiedAt)).not.toBeNaN();
  });

  it("returns an empty list when the directory is missing", async () => {
    expect(await listWorlds(join(dir, "nope"))).toEqual([]);
  });

  it("propagates a non-ENOENT error instead of returning an empty list", async () => {
    const notADir = join(dir, "notes.txt");
    await expect(listWorlds(notADir)).rejects.toThrow(notADir);
  });
});

describe("worldExists", () => {
  it("is true for an existing world and false otherwise", async () => {
    expect(await worldExists(dir, "Tulsa")).toBe(true);
    expect(await worldExists(dir, "Brand New")).toBe(false);
  });

  it("is case-insensitive, matching Windows filesystem behaviour", async () => {
    expect(await worldExists(dir, "tULSA")).toBe(true);
  });
});

describe("isValidWorldName", () => {
  it("rejects empty, path separators, and characters Windows forbids", () => {
    expect(isValidWorldName("Good Name")).toBe(true);
    expect(isValidWorldName("")).toBe(false);
    expect(isValidWorldName("   ")).toBe(false);
    expect(isValidWorldName("a/b")).toBe(false);
    expect(isValidWorldName("a\\b")).toBe(false);
    expect(isValidWorldName("a:b")).toBe(false);
    expect(isValidWorldName("a?b")).toBe(false);
    expect(isValidWorldName("..")).toBe(false);
  });

  it("rejects names containing control characters", () => {
    const nulChar = String.fromCharCode(0);
    const unitSeparatorChar = String.fromCharCode(31);
    expect(isValidWorldName("a" + nulChar + "b")).toBe(false);
    expect(isValidWorldName("a" + unitSeparatorChar + "b")).toBe(false);
    expect(isValidWorldName("a" + String.fromCharCode(10) + "b")).toBe(false);
    expect(isValidWorldName("a" + String.fromCharCode(9) + "b")).toBe(false);
  });

  it("accepts ordinary punctuation that appears in real world names", () => {
    expect(isValidWorldName("Goober Goof")).toBe(true);
    expect(isValidWorldName("Jeff and Eli")).toBe(true);
    expect(isValidWorldName("v1.2 world")).toBe(true);
    expect(isValidWorldName("Jeff-Eli_World")).toBe(true);
    expect(isValidWorldName("Jeff's World")).toBe(true);
    expect(isValidWorldName("World (Backup)")).toBe(true);
  });
});
