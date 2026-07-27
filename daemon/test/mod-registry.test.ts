import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModRegistry } from "../src/mod-registry.js";

let file: string;
let reg: ModRegistry;

beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), "necesse-mods-")), "mods.json");
  reg = new ModRegistry(file);
});

const entry = {
  id: "3731244177",
  name: "Safe Haven QOL",
  jar: "SafeHavenQOL-1.2.0-2.6.jar",
  lastUpdated: "2026-07-26T04:24:00.000Z",
};

describe("ModRegistry", () => {
  it("returns an empty list when the file does not exist", async () => {
    expect(await reg.load()).toEqual([]);
  });

  it("persists an entry across instances", async () => {
    await reg.upsert(entry);
    expect(await new ModRegistry(file).get("3731244177")).toEqual(entry);
  });

  it("replaces rather than duplicates on repeat upsert", async () => {
    await reg.upsert(entry);
    await reg.upsert({ ...entry, jar: "SafeHavenQOL-1.2.0-2.7.jar" });
    const all = await reg.load();
    expect(all).toHaveLength(1);
    expect(all[0].jar).toBe("SafeHavenQOL-1.2.0-2.7.jar");
  });

  it("returns the removed entry, and undefined for an unknown id", async () => {
    await reg.upsert(entry);
    expect((await reg.remove("3731244177"))?.jar).toBe(entry.jar);
    expect(await reg.load()).toEqual([]);
    expect(await reg.remove("3731244177")).toBeUndefined();
  });

  it("throws with the file path on malformed JSON rather than silently resetting", async () => {
    await writeFile(file, "{{{");
    await expect(reg.load()).rejects.toThrow(file);
  });

  it("writes readable JSON", async () => {
    await reg.upsert(entry);
    expect(await readFile(file, "utf8")).toContain("\n  ");
  });

  it("propagates a non-ENOENT read failure instead of returning an empty list", async () => {
    // Point the registry at a directory instead of a file: reading it throws
    // EISDIR (not ENOENT), which must NOT be swallowed into [].
    await mkdir(file);
    await expect(reg.load()).rejects.toThrow(file);
  });
});
