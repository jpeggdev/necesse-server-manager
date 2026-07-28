import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModLibrary } from "../src/mod-library.js";
import { NotAModJarError, safeModId } from "../src/mod-info.js";
import { makeModJar, makeNonModJar, modJarBytes } from "./fixtures/mod-jar.js";

let root: string;
let incoming: string;
let library: ModLibrary;
let libraryDir: string;
let manifestFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-modlib-"));
  incoming = join(root, "incoming");
  libraryDir = join(root, "mod-library");
  manifestFile = join(root, "mod-library.json");
  library = new ModLibrary(manifestFile, libraryDir);
});

describe("add", () => {
  it("files a jar under its mod.info id, keeping the original filename", async () => {
    const path = await makeModJar(incoming, "AutoTorch-1.0.jar", {
      id: "jpegg.autotorch",
      name: "AutoTorch",
      version: "1.0",
      gameVersion: "1.2.0",
      author: "jpegg",
    });

    const entry = await library.add(path, { kind: "workshop", workshopId: "3754847143" });

    expect(entry).toMatchObject({
      id: "jpegg.autotorch",
      name: "AutoTorch",
      version: "1.0",
      gameVersion: "1.2.0",
      author: "jpegg",
      jar: "AutoTorch-1.0.jar",
      source: { kind: "workshop", workshopId: "3754847143" },
    });
    expect(entry.sizeBytes).toBeGreaterThan(0);
    expect(await readdir(join(libraryDir, "jpegg.autotorch"))).toEqual(["AutoTorch-1.0.jar"]);
    expect(await readFile(library.jarPath(entry))).toEqual(await readFile(path));
  });

  it("records where a jar came from, so Update All still knows what is a workshop mod", async () => {
    const a = await makeModJar(incoming, "A.jar", { id: "x.a", version: "1" });
    const b = await makeModJar(incoming, "B.jar", { id: "x.b", version: "1" });
    await library.add(a, { kind: "workshop", workshopId: "111" });
    await library.add(b, { kind: "local", how: "adopted" });
    const sources = Object.fromEntries((await library.load()).map((m) => [m.id, m.source]));
    expect(sources["x.a"]).toEqual({ kind: "workshop", workshopId: "111" });
    expect(sources["x.b"]).toEqual({ kind: "local", how: "adopted" });
  });

  // Two jars for one mod is precisely the state that makes the game load it
  // twice, so the library holds exactly one per id and the old jar goes.
  it("keeps one jar per mod id, replacing the old file when the version renames it", async () => {
    await library.add(
      await makeModJar(incoming, "AutoTorch-1.0.jar", { id: "jpegg.autotorch", version: "1.0" }),
      { kind: "workshop", workshopId: "1" },
    );
    const entry = await library.add(
      await makeModJar(incoming, "AutoTorch-1.1.jar", { id: "jpegg.autotorch", version: "1.1" }),
      { kind: "workshop", workshopId: "1" },
    );

    expect(await library.load()).toHaveLength(1);
    expect(entry.version).toBe("1.1");
    expect(await readdir(join(libraryDir, "jpegg.autotorch"))).toEqual(["AutoTorch-1.1.jar"]);
  });

  // Same jar name, two different mods: the per-id folder is what stops one
  // overwriting the other.
  it("keeps two mods that ship the same jar filename apart", async () => {
    await library.add(await makeModJar(join(incoming, "one"), "mod.jar", { id: "a.one" }), {
      kind: "local",
      how: "upload",
    });
    await library.add(await makeModJar(join(incoming, "two"), "mod.jar", { id: "b.two" }), {
      kind: "local",
      how: "upload",
    });
    expect((await library.load()).map((m) => m.id)).toEqual(["a.one", "b.two"]);
    for (const id of ["a.one", "b.two"]) {
      expect(await readdir(join(libraryDir, safeModId(id)))).toEqual(["mod.jar"]);
    }
  });

  it("refuses a jar that is not a Necesse mod, writing nothing at all", async () => {
    const path = await makeNonModJar(incoming, "NotAMod.jar");
    await expect(library.add(path, { kind: "local", how: "upload" })).rejects.toThrow(NotAModJarError);
    expect(await library.load()).toEqual([]);
    await expect(readdir(libraryDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("addBytes", () => {
  it("validates the mod.info before the bytes reach the disk", async () => {
    const bytes = await modJarBytes({ id: "irrelevant" }, { omitInfo: true });
    await expect(
      library.addBytes(bytes, "Sneaky.jar", { kind: "local", how: "upload" }),
    ).rejects.toThrow(NotAModJarError);
    expect(await library.load()).toEqual([]);
    await expect(readdir(libraryDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a filename that is a path before it does any work on the bytes", async () => {
    const bytes = await modJarBytes({ id: "a.b", version: "1" });
    await expect(
      library.addBytes(bytes, "..\\..\\Server.jar", { kind: "local", how: "upload" }),
    ).rejects.toThrow(/not a plain filename/);
    expect(await library.load()).toEqual([]);
  });

  it("names the jar after the mod when the caller offers no filename", async () => {
    const bytes = await modJarBytes({ id: "a.b", version: "1" });
    const entry = await library.addBytes(bytes, undefined, { kind: "local", how: "upload" });
    expect(entry.jar).toBe("a.b.jar");
    expect(await readFile(library.jarPath(entry))).toEqual(bytes);
  });
});

describe("resolve", () => {
  it("hands back the jar's real path for a mod it holds", async () => {
    await library.add(await makeModJar(incoming, "A.jar", { id: "x.a", version: "1" }), {
      kind: "local",
      how: "upload",
    });
    const hit = await library.resolve("x.a");
    expect(hit?.entry.id).toBe("x.a");
    expect(await readFile(hit!.path)).toBeInstanceOf(Buffer);
  });

  it("returns nothing for a mod it has never had", async () => {
    expect(await library.resolve("nobody.nothing")).toBeUndefined();
  });

  // The manifest is a claim; resolve checks the file. Reconcile deletes on the
  // strength of this answer, so "we have an entry" is not good enough.
  it("returns nothing when the manifest claims a jar that is no longer on disk", async () => {
    const entry = await library.add(await makeModJar(incoming, "A.jar", { id: "x.a" }), {
      kind: "local",
      how: "upload",
    });
    await rm(library.jarPath(entry));
    expect(await library.resolve("x.a")).toBeUndefined();
    // ...while the entry is still listed, so the operator can see what was lost.
    expect(await library.get("x.a")).toBeDefined();
  });
});

describe("the manifest", () => {
  it("is an empty library when the file has never been written", async () => {
    expect(await library.load()).toEqual([]);
  });

  it("refuses to guess at a manifest it cannot parse", async () => {
    await writeFile(manifestFile, "{ not json");
    await expect(library.load()).rejects.toThrow(/Failed to parse mod library manifest/);
    await expect(library.load()).rejects.toThrow(manifestFile);
  });

  it("propagates a real read failure instead of reporting an empty library", async () => {
    // A directory where the manifest should be: EISDIR/EPERM, not ENOENT.
    const weird = new ModLibrary(libraryDir, libraryDir);
    await library.add(await makeModJar(incoming, "A.jar", { id: "x.a" }), {
      kind: "local",
      how: "upload",
    });
    await expect(weird.load()).rejects.toThrow(/Failed to read mod library manifest/);
  });
});

describe("remove", () => {
  it("drops the entry and the jar, and reports an id it never had", async () => {
    const entry = await library.add(await makeModJar(incoming, "A.jar", { id: "x.a" }), {
      kind: "local",
      how: "upload",
    });
    expect((await library.remove("x.a"))?.id).toBe("x.a");
    expect(await library.load()).toEqual([]);
    await expect(readFile(library.jarPath(entry))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await library.remove("x.a")).toBeUndefined();
  });
});
