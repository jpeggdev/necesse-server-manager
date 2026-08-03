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

/*
 * `__proto__` is a legal Windows filename, so it is a possible world name, and
 * `normaliseWorld` only lowercases it - it survives to the key unchanged. On a
 * plain object every operation in this class is then wrong, and silently:
 * `all["__proto__"] = entry` runs Object.prototype's setter and replaces the
 * prototype rather than storing anything (so `set` returns an entry the route
 * reports as saved while nothing reaches disk), reading it back hands out
 * Object.prototype, which is not undefined and so passes the "already has a
 * set" checks in http.ts's setFor and mod-migration's seeding loop, and delete
 * removes nothing while reporting a removal.
 */
describe("a world named __proto__", () => {
  it("stores its set and reads it back off disk", async () => {
    const written = await sets.set("__proto__", ["a.one", "b.two"]);
    expect(written.modIds).toEqual(["a.one", "b.two"]);
    expect((await sets.get("__proto__"))?.modIds).toEqual(["a.one", "b.two"]);

    // Reopened, because the in-memory record and the file are two separate
    // claims: a prototype assignment is not serialised by JSON.stringify at
    // all, so only a reload proves the save actually landed.
    const reopened = new ModSets(file);
    expect((await reopened.get("__proto__"))?.modIds).toEqual(["a.one", "b.two"]);
    expect(Object.keys(await reopened.load())).toEqual(["__proto__"]);
  });

  it("reports no set before one is stored, rather than handing back Object.prototype", async () => {
    // The bug this pins is not visible to toEqual: Object.prototype has no
    // enumerable own properties, so it looks empty. Its danger is that it is
    // not undefined, so `existing !== undefined` wrongly passes and the caller
    // then reads `.modIds` off it as undefined.
    await sets.set("Tulsa", ["a.one"]);
    const got = await sets.get("__proto__");
    expect(got).toBeUndefined();
    expect(got).not.toBe(Object.prototype);
  });

  it("reports nothing removed when it had no set", async () => {
    expect(await sets.remove("__proto__")).toBeUndefined();
  });

  it("removes its set once it has one", async () => {
    await sets.set("__proto__", ["a.one"]);
    expect((await sets.remove("__proto__"))?.modIds).toEqual(["a.one"]);
    expect(await sets.get("__proto__")).toBeUndefined();
  });

  it("keeps it apart from other worlds, and pollutes nothing", async () => {
    await sets.set("__proto__", ["a.one"]);
    await sets.set("Tulsa", ["b.two"]);

    expect((await sets.get("__proto__"))?.modIds).toEqual(["a.one"]);
    expect((await sets.get("Tulsa"))?.modIds).toEqual(["b.two"]);
    // Nothing leaked onto every object in the process.
    expect((({}) as Record<string, unknown>).modIds).toBeUndefined();
  });
});

describe("a stored file whose contents are valid JSON but not a record", () => {
  // Object.assign ignores a null source, where the previous `JSON.parse(raw)`
  // cast returned it and made every read throw on property access instead.
  it("reads as no sets rather than throwing on the next get", async () => {
    await sets.set("Tulsa", []);
    await writeFile(file, "null");
    expect(await sets.load()).toEqual({});
    expect(await sets.get("Tulsa")).toBeUndefined();
  });
});
