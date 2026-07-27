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

  it("reports size and modified time", async () => {
    const tulsa = (await listWorlds(dir)).find((w) => w.name === "Tulsa");
    expect(tulsa?.sizeBytes).toBe(1);
    expect(Date.parse(tulsa!.modifiedAt)).not.toBeNaN();
  });

  it("returns an empty list when the directory is missing", async () => {
    expect(await listWorlds(join(dir, "nope"))).toEqual([]);
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
});
