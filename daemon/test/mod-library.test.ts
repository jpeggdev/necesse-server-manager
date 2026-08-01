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

  /*
   * Two jars for one mod in the MODS FOLDER is what makes the game load it
   * twice, so exactly one per id is current. In the library both are kept: the
   * library is the only copy of a hand-placed or uploaded jar, and reconcile
   * deletes from the folder on the strength of the library holding those bytes,
   * so overwriting an older jar with a newer one destroys the older one for
   * good. Disk is cheap.
   */
  it("makes the new jar current and RETAINS the one it replaced", async () => {
    const first = await makeModJar(incoming, "AutoTorch-1.0.jar", {
      id: "jpegg.autotorch",
      version: "1.0",
    });
    const firstBytes = await readFile(first);
    await library.add(first, { kind: "workshop", workshopId: "1" });

    const entry = await library.add(
      await makeModJar(incoming, "AutoTorch-1.1.jar", { id: "jpegg.autotorch", version: "1.1" }),
      { kind: "workshop", workshopId: "1" },
    );

    expect(await library.load()).toHaveLength(1);
    expect(entry.version).toBe("1.1");
    expect(entry.jar).toBe("AutoTorch-1.1.jar");
    expect(entry.superseded.map((j) => j.jar)).toEqual(["AutoTorch-1.0.jar"]);
    expect((await readdir(join(libraryDir, "jpegg.autotorch"))).sort()).toEqual([
      "AutoTorch-1.0.jar",
      "AutoTorch-1.1.jar",
    ]);
    // Byte for byte, still restorable.
    expect(await readFile(library.jarPath(entry, "AutoTorch-1.0.jar"))).toEqual(firstBytes);
  });

  it("never writes over a different jar that already uses that filename", async () => {
    const a = await makeModJar(join(incoming, "a"), "Mod.jar", { id: "x.a", version: "1" });
    const aBytes = await readFile(a);
    await library.add(a, { kind: "local", how: "upload" });
    // A rebuild shipped under the same name: same filename, different bytes.
    const b = await makeModJar(join(incoming, "b"), "Mod.jar", { id: "x.a", version: "1" }, {
      filler: "rebuilt",
    });

    const entry = await library.add(b, { kind: "local", how: "upload" });

    // The disambiguation is the LIBRARY's storage name only. `jar` - the name
    // the mods folder will receive, and what the game logs - keeps the name the
    // jar arrived under, so a re-upload cannot leave `Mod-d4471746.jar` sitting
    // in %APPDATA%\Necesse\mods forever.
    expect(entry.jar).toBe("Mod.jar");
    expect(entry.file).not.toBe("Mod.jar");
    expect(entry.file).toMatch(/^Mod-[0-9a-f]{8}\.jar$/);
    // Both sets of bytes are still there, neither written over the other.
    expect(await readFile(library.jarPath(entry, "Mod.jar"))).toEqual(aBytes);
    expect(await readFile(library.jarPath(entry))).toEqual(await readFile(b));
  });

  it("recognises bytes it already holds rather than filing them twice", async () => {
    const path = await makeModJar(incoming, "A.jar", { id: "x.a", version: "1" });
    const entry = await library.add(path, { kind: "local", how: "upload" });
    expect(await library.holds("x.a", entry.sha256)).toBe(true);
    expect(await library.holds("x.a", "0".repeat(64))).toBe(false);
    expect(await library.holds("nobody.nothing", entry.sha256)).toBe(false);

    await library.add(path, { kind: "local", how: "upload" });

    expect(library.jarsOf((await library.get("x.a"))!)).toHaveLength(1);
  });
});

/*
 * `retain` is what adopting out of the mods folder uses. It must guarantee the
 * bytes are held WITHOUT changing which jar is current: dropping an old jar into
 * the folder must not silently downgrade every world that loads that mod, and
 * an `Update All` writing a new version here must not be undone by the old jar
 * still sitting in the folder.
 */
describe("retain", () => {
  it("keeps the bytes without promoting them over the current jar", async () => {
    await library.add(
      await makeModJar(incoming, "A-2.jar", { id: "x.a", version: "2" }),
      { kind: "workshop", workshopId: "1" },
    );
    const old = await makeModJar(join(incoming, "old"), "A-1.jar", { id: "x.a", version: "1" });

    const { entry, stored } = await library.retain(old, { kind: "local", how: "adopted" });

    expect(stored).toBe(true);
    expect(entry.jar).toBe("A-2.jar");
    expect(entry.version).toBe("2");
    expect(entry.superseded.map((j) => j.jar)).toEqual(["A-1.jar"]);
    expect(await readFile(library.jarPath(entry, "A-1.jar"))).toEqual(await readFile(old));
  });

  it("makes a mod the library has never heard of current, since there is nothing to preserve", async () => {
    const { entry, stored } = await library.retain(
      await makeModJar(incoming, "A-1.jar", { id: "x.a", version: "1" }),
      { kind: "local", how: "adopted" },
    );
    expect(stored).toBe(true);
    expect(entry.jar).toBe("A-1.jar");
    expect(entry.superseded).toEqual([]);
  });

  it("stores nothing when the exact bytes are already held", async () => {
    const path = await makeModJar(incoming, "A-1.jar", { id: "x.a", version: "1" });
    await library.add(path, { kind: "local", how: "upload" });

    const { stored } = await library.retain(path, { kind: "local", how: "adopted" });

    expect(stored).toBe(false);
    expect(library.jarsOf((await library.get("x.a"))!)).toHaveLength(1);
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

describe("resolveByWorkshopId", () => {
  async function addSafeHaven(): Promise<void> {
    const path = await makeModJar(incoming, "SafeHavenQOL-1.2.0-2.6.jar", {
      id: "vendor.safehavenqol",
      version: "1.2.0-2.6",
    });
    await library.add(path, { kind: "workshop", workshopId: "3731244177" }, "SafeHavenQOL-1.2.0-2.6.jar");
  }

  it("finds the current entry by workshop id, which is not the id it files jars under", async () => {
    await addSafeHaven();

    const found = await library.resolveByWorkshopId("3731244177");
    expect(found?.entry.jar).toBe("SafeHavenQOL-1.2.0-2.6.jar");
    expect(await readFile(found!.path)).toBeInstanceOf(Buffer);

    // The guard against keying this off the wrong id: the library files this jar
    // under the mod id from inside it, so a lookup by that id must NOT be how
    // this works, and an unknown workshop id must miss.
    expect(await library.resolveByWorkshopId("0000000000")).toBeUndefined();
  });

  // Same claim-versus-file distinction `resolve` makes, and the reason this
  // returns a path rather than an entry: Update All skips on this answer, so a
  // manifest entry whose jar is gone must read as "not held".
  it("returns nothing when the manifest claims a jar that is no longer on disk", async () => {
    await addSafeHaven();
    await rm(library.jarPath((await library.get("vendor.safehavenqol"))!));

    expect(await library.resolveByWorkshopId("3731244177")).toBeUndefined();
    expect(await library.get("vendor.safehavenqol")).toBeDefined();
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
  it("drops the entry and every jar it held, and reports an id it never had", async () => {
    await library.add(await makeModJar(incoming, "A-1.jar", { id: "x.a", version: "1" }), {
      kind: "local",
      how: "upload",
    });
    const entry = await library.add(
      await makeModJar(join(incoming, "two"), "A-2.jar", { id: "x.a", version: "2" }),
      { kind: "local", how: "upload" },
    );
    expect(entry.superseded).toHaveLength(1);

    expect((await library.remove("x.a"))?.id).toBe("x.a");

    expect(await library.load()).toEqual([]);
    for (const jar of ["A-1.jar", "A-2.jar"]) {
      await expect(readFile(library.jarPath(entry, jar))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await library.remove("x.a")).toBeUndefined();
  });
});

/*
 * The manifest indexes jars that exist nowhere else. A crash mid-write used to
 * be able to truncate it, after which `load` throws on every call and every
 * start refuses until somebody repairs it by hand - so it is replaced by
 * rename, never written in place.
 */
describe("the manifest is replaced atomically", () => {
  it("leaves no partial file and no temp file behind", async () => {
    await library.add(await makeModJar(incoming, "A.jar", { id: "x.a" }), {
      kind: "local",
      how: "upload",
    });
    await library.add(await makeModJar(join(incoming, "b"), "B.jar", { id: "x.b" }), {
      kind: "local",
      how: "upload",
    });

    expect((await library.load()).map((m) => m.id)).toEqual(["x.a", "x.b"]);
    // The temp file the rename consumed is gone, and nothing that is not the
    // manifest is sitting beside it.
    expect((await readdir(root)).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(JSON.parse(await readFile(manifestFile, "utf8"))).toHaveLength(2);
  });
});
