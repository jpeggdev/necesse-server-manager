import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModSets, normaliseWorld } from "../src/mod-sets.js";

let file: string;
let sets: ModSets;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "necesse-modsets-"));
  file = join(root, "nested", "mod-sets.json");
  sets = new ModSets(file);
});

describe("world name normalisation", () => {
  it("trims and lowercases, because that is what Windows and listWorlds do", () => {
    expect(normaliseWorld("  Summoner World ")).toBe("summoner world");
  });

  /*
   * The one that would bite in production. `listWorlds` reads world names off
   * disk and `worldZipPath` matches them case-insensitively, so "Summoner
   * World" and "summoner world" are the same world everywhere else in this
   * daemon. A set filed under the wrong case would simply never apply, and the
   * first sign of it would be a start that loaded the wrong mods.
   */
  it("finds a world's set whatever case the caller asks in", async () => {
    await sets.set("Summoner World", ["a.one", "b.two"]);

    for (const asked of ["Summoner World", "summoner world", "SUMMONER WORLD", " Summoner World "]) {
      expect((await sets.get(asked))?.modIds, asked).toEqual(["a.one", "b.two"]);
    }
  });

  it("overwrites rather than duplicating when the same world is written in another case", async () => {
    await sets.set("Summoner World", ["a.one"]);
    await sets.set("summoner world", ["b.two"]);

    expect(Object.keys(await sets.load())).toEqual(["summoner world"]);
    expect((await sets.get("SUMMONER WORLD"))?.modIds).toEqual(["b.two"]);
    // The display name is whatever was written last, not the normalised key.
    expect((await sets.get("Summoner World"))?.world).toBe("summoner world");
  });
});

describe("reading and writing", () => {
  it("has no sets at all before the file exists", async () => {
    expect(await sets.load()).toEqual({});
    expect(await sets.get("Anything")).toBeUndefined();
  });

  it("creates the directory it writes into", async () => {
    await sets.set("Tulsa", []);
    expect(JSON.parse(await readFile(file, "utf8"))).toHaveProperty("tulsa");
  });

  it("collapses a repeated id, since a set is a set", async () => {
    const written = await sets.set("Tulsa", ["a.one", "a.one", "b.two"]);
    expect(written.modIds).toEqual(["a.one", "b.two"]);
  });

  it("keeps an empty set as a real, configured choice rather than as no set", async () => {
    await sets.set("Vanilla World", []);
    const got = await sets.get("Vanilla World");
    expect(got).toBeDefined();
    expect(got?.modIds).toEqual([]);
  });

  it("keeps worlds apart", async () => {
    await sets.set("One", ["a"]);
    await sets.set("Two", ["b"]);
    expect((await sets.get("One"))?.modIds).toEqual(["a"]);
    expect((await sets.get("Two"))?.modIds).toEqual(["b"]);
  });

  it("removes a set and reports a world that had none", async () => {
    await sets.set("Gone", ["a"]);
    expect((await sets.remove("GONE"))?.modIds).toEqual(["a"]);
    expect(await sets.get("Gone")).toBeUndefined();
    expect(await sets.remove("Gone")).toBeUndefined();
  });

  it("refuses to guess at a file it cannot parse", async () => {
    await sets.set("Tulsa", []);
    await writeFile(file, "{ not json");
    await expect(sets.load()).rejects.toThrow(/Failed to parse mod sets/);
    await expect(sets.load()).rejects.toThrow(file);
  });
});
