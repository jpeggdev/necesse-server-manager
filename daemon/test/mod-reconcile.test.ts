import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModLibrary } from "../src/mod-library.js";
import { ReconcileError, installedModIds, reconcileMods } from "../src/mod-reconcile.js";
import { MOD_INFO_SUMMONER_EXPANSION, makeModJar, makeNonModJar } from "./fixtures/mod-jar.js";

let root: string;
let modsDir: string;
let incoming: string;
let library: ModLibrary;

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const jarsIn = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter((f) => f.endsWith(".jar")).sort();

/**
 * Puts a jar straight into the mods folder, as steamcmd or a person would.
 * `filler` makes two jars of one mod differ in bytes as well as in name, which
 * is what the library's hash test is actually deciding on.
 */
const install = (
  filename: string,
  fields: Parameters<typeof makeModJar>[2],
  filler?: string,
): Promise<string> =>
  makeModJar(modsDir, filename, fields, filler === undefined ? {} : { filler });

/** Puts a jar into the library without it ever passing through the mods folder. */
const stock = async (filename: string, fields: Parameters<typeof makeModJar>[2]): Promise<void> => {
  const path = await makeModJar(incoming, filename, fields);
  await library.add(path, { kind: "workshop", workshopId: "1" }, filename);
  await rm(path);
};

const run = (modIds: string[], world = "Summoner World"): ReturnType<typeof reconcileMods> =>
  reconcileMods({ modsDir, library, world, modIds, log: () => {} });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-reconcile-"));
  modsDir = join(root, "mods");
  incoming = join(root, "incoming");
  await mkdir(modsDir, { recursive: true });
  library = new ModLibrary(join(root, "mod-library.json"), join(root, "mod-library"));
});

/*
 * The invariant the whole feature rests on. A jar somebody dropped into the
 * mods folder by hand - which is exactly how SummonerExpansion-1.2.0-7.7.jar
 * got onto the live server - is the only copy of that mod anywhere. Reconcile
 * removing it from the folder is only allowed because it was copied into the
 * library first.
 */
describe("adopt before pruning", () => {
  it("survives a reconcile that takes it out of the mods folder, because the library has it", async () => {
    const path = await makeModJar(modsDir, "SummonerExpansion-1.2.0-7.7.jar", {}, {
      info: MOD_INFO_SUMMONER_EXPANSION,
    });
    const original = await readFile(path);

    // A set that does not name it at all: the folder must end up empty.
    const summary = await run([]);

    expect(await jarsIn(modsDir)).toEqual([]);
    expect(summary.adopted).toEqual(["SummonerExpansion-1.2.0-7.7.jar"]);
    expect(summary.removed).toEqual(["SummonerExpansion-1.2.0-7.7.jar"]);

    // Byte for byte, still there, and putting it back is one more reconcile.
    const held = await library.resolve("gagadoliano.summonerexpansion");
    expect(held).toBeDefined();
    expect(sha(await readFile(held!.path))).toBe(sha(original));

    await run(["gagadoliano.summonerexpansion"]);
    expect(await jarsIn(modsDir)).toEqual(["SummonerExpansion-1.2.0-7.7.jar"]);
    expect(sha(await readFile(join(modsDir, "SummonerExpansion-1.2.0-7.7.jar")))).toBe(sha(original));
  });

  it("adopts every unknown jar before it removes any of them", async () => {
    await install("A-1.jar", { id: "x.a", version: "1" });
    await install("B-1.jar", { id: "x.b", version: "1" });
    await install("C-1.jar", { id: "x.c", version: "1" });

    await run(["x.b"]);

    expect(await jarsIn(modsDir)).toEqual(["B-1.jar"]);
    for (const id of ["x.a", "x.b", "x.c"]) {
      expect(await library.resolve(id), id).toBeDefined();
    }
  });

  /*
   * The case that decides what gets deleted, and the one this originally got
   * wrong: adoption gated on the mod id while pruning gated on the filename, so
   * a jar whose id the library knew UNDER A DIFFERENT FILENAME was skipped by
   * adopt and then deleted - existing in neither place afterwards.
   *
   * "The library can restore this mod" is not the same claim as "the library can
   * restore this jar", and only the second one licenses a delete. Membership is
   * therefore decided by the hash of the bytes.
   */
  it("retains a jar whose mod it knows but whose bytes it does not, and still installs its own", async () => {
    await stock("A-2.jar", { id: "x.a", version: "2" });
    // The only copy of this build anywhere - a hand-drop, exactly like
    // SummonerExpansion on the live box.
    const handDropped = await readFile(await install("A-1.jar", { id: "x.a", version: "1" }));

    const summary = await run(["x.a"]);

    // Taken in before it was removed, rather than destroyed.
    expect(summary.adopted).toEqual(["A-1.jar"]);
    expect(summary.removed).toEqual(["A-1.jar"]);
    const entry = await library.get("x.a");
    const retained = entry?.superseded.find((j) => j.jar === "A-1.jar");
    expect(retained).toBeDefined();
    expect(sha(await readFile(library.jarPath(entry!, "A-1.jar")))).toBe(sha(handDropped));

    // ...and adopting it did NOT promote it: the library's own copy is still
    // what the world loads, so dropping an old jar in a folder cannot silently
    // downgrade every world that loads that mod.
    expect(await jarsIn(modsDir)).toEqual(["A-2.jar"]);
    expect(entry?.version).toBe("2");
    expect(entry?.jar).toBe("A-2.jar");
  });

  it("re-adopts nothing when the library already holds those exact bytes", async () => {
    await install("A-1.jar", { id: "x.a", version: "1" });
    await run(["x.a"]);

    const again = await run(["x.a"]);

    expect(again.adopted).toEqual([]);
    expect((await library.get("x.a"))?.superseded).toEqual([]);
  });

  it("retains a second build that arrives under the same filename, without overwriting the first", async () => {
    // A workshop mod rebuilt without renaming its jar: same name, different
    // bytes. Writing over the first one would destroy it.
    await install("Mod.jar", { id: "x.a", version: "1" });
    await run(["x.a"]);
    const first = await readFile(library.jarPath((await library.get("x.a"))!));
    await rm(join(modsDir, "Mod.jar"));
    const second = await readFile(await install("Mod.jar", { id: "x.a", version: "1" }, "rebuilt"));

    await run([]);

    const entry = (await library.get("x.a"))!;
    const held = library.jarsOf(entry);
    expect(held).toHaveLength(2);
    const bytes = await Promise.all(held.map((j) => readFile(library.jarPath(entry, j.jar))));
    expect(bytes.map(sha).sort()).toEqual([sha(first), sha(second)].sort());
  });

  it("never touches anything that is not a .jar", async () => {
    await writeFile(join(modsDir, "modlist.data"), "the game's own file");
    await install("A-1.jar", { id: "x.a", version: "1" });

    await run([]);

    expect(await readdir(modsDir)).toEqual(["modlist.data"]);
  });
});

describe("a set naming a mod the library cannot restore", () => {
  it("refuses, names the mod, and leaves the folder exactly as it was", async () => {
    await install("A-1.jar", { id: "x.a", version: "1" });
    const before = await jarsIn(modsDir);

    await expect(run(["x.a", "x.gone", "x.also-gone"])).rejects.toThrow(ReconcileError);
    await expect(run(["x.a", "x.gone"])).rejects.toThrow(/x\.gone/);
    await expect(run(["x.a", "x.gone"])).rejects.toThrow(/was not started/);

    expect(await jarsIn(modsDir)).toEqual(before);
  });

  it("refuses when the library's manifest names a jar that is no longer on disk", async () => {
    await stock("A-1.jar", { id: "x.a", version: "1" });
    const entry = await library.get("x.a");
    await rm(library.jarPath(entry!));

    await expect(run(["x.a"])).rejects.toThrow(/no jar for: x\.a/);
  });
});

/*
 * A jar with no readable mod.info can be neither adopted (there is no id to
 * file it under) nor deleted (that would be losing the only copy). So reconcile
 * refuses, before it has written anything, and says which file.
 */
describe("a jar in the mods folder that is not a Necesse mod", () => {
  it("stops everything and leaves the folder untouched", async () => {
    await install("Real-1.jar", { id: "x.a", version: "1" });
    await makeNonModJar(modsDir, "Mystery.jar");

    await expect(run(["x.a"])).rejects.toThrow(ReconcileError);
    await expect(run(["x.a"])).rejects.toThrow(/Mystery\.jar/);
    await expect(run(["x.a"])).rejects.toThrow(/Move it out of/);

    expect(await jarsIn(modsDir)).toEqual(["Mystery.jar", "Real-1.jar"]);
    // Nothing was adopted either: the refusal came before any writing at all.
    expect(await library.load()).toEqual([]);
  });
});

/*
 * The game loads every jar in the folder, so an old and a new jar of one mod
 * both being there means the mod loads twice. The library holds one jar per id
 * and so must the folder.
 */
describe("two jars with the same mod id", () => {
  it("resolves to one, keeping the higher declared version", async () => {
    await install("Mod-1.2.0-7.7.jar", { id: "x.a", version: "7.7" }, "new");
    await install("Mod-1.2.0-7.10.jar", { id: "x.a", version: "7.10" }, "newer");

    const summary = await run(["x.a"]);

    // 7.10 > 7.7 numerically, which a string compare would get backwards.
    expect(await jarsIn(modsDir)).toEqual(["Mod-1.2.0-7.10.jar"]);
    expect(summary.removed).toEqual(["Mod-1.2.0-7.7.jar"]);
    expect((await library.get("x.a"))?.version).toBe("7.10");
  });

  /*
   * The loser of a duplicate pair is pruned like anything else, so it has to be
   * retained like anything else. Adopting only the keepers left it deleted and
   * unrecoverable - and if the library already held that id, neither jar was
   * taken in at all.
   */
  it("retains BOTH jars, loser included, before either is pruned", async () => {
    const older = await readFile(await install("Mod-1.jar", { id: "x.a", version: "1" }, "old"));
    const newer = await readFile(await install("Mod-2.jar", { id: "x.a", version: "2" }, "new"));

    const summary = await run([]);

    expect(await jarsIn(modsDir)).toEqual([]);
    expect(summary.adopted.sort()).toEqual(["Mod-1.jar", "Mod-2.jar"]);
    const entry = (await library.get("x.a"))!;
    expect(entry.version).toBe("2");
    const bytes = await Promise.all(
      library.jarsOf(entry).map((j) => readFile(library.jarPath(entry, j.jar))),
    );
    expect(bytes.map(sha).sort()).toEqual([sha(older), sha(newer)].sort());
  });

  it("retains both even when the library already knows the mod", async () => {
    await stock("Mod-9.jar", { id: "x.a", version: "9" });
    await install("Mod-1.jar", { id: "x.a", version: "1" }, "old");
    await install("Mod-2.jar", { id: "x.a", version: "2" }, "new");

    const summary = await run(["x.a"]);

    expect(summary.adopted.sort()).toEqual(["Mod-1.jar", "Mod-2.jar"]);
    expect(library.jarsOf((await library.get("x.a"))!)).toHaveLength(3);
    expect(await jarsIn(modsDir)).toEqual(["Mod-9.jar"]);
  });

  /*
   * Mods routinely ship a new build without bumping the declared version, so
   * the tie-break decides real cases. It must compare the FILENAMES - comparing
   * the version strings again would decide nothing (they are equal by then) and
   * leave the outcome to readdir's ordering.
   */
  it("breaks a version tie on the filename, not on the equal version strings", async () => {
    await install("A-1.0.jar", { id: "x.a", version: "7.7" }, "first-by-readdir");
    await install("B-2.0.jar", { id: "x.a", version: "7.7" }, "later-name");

    await run(["x.a"]);

    expect(await jarsIn(modsDir)).toEqual(["B-2.0.jar"]);
    // ...and the one it did not pick is still there to switch back to.
    expect(library.jarsOf((await library.get("x.a"))!).map((j) => j.jar).sort()).toEqual([
      "A-1.0.jar",
      "B-2.0.jar",
    ]);
  });

  it("reports the discarded duplicate rather than removing it silently", async () => {
    await install("Mod-1.jar", { id: "x.a", version: "1" }, "old");
    await install("Mod-2.jar", { id: "x.a", version: "2" }, "new");
    const lines: string[] = [];

    await reconcileMods({ modsDir, library, world: "W", modIds: ["x.a"], log: (l) => lines.push(l) });

    expect(lines.join("\n")).toMatch(/Mod-1\.jar/);
    expect(lines.join("\n")).toMatch(/would load it twice/);
  });
});

describe("bringing the folder to the set", () => {
  it("copies in what is missing and keeps what already matches", async () => {
    await stock("A-1.jar", { id: "x.a", version: "1" });
    await stock("B-1.jar", { id: "x.b", version: "1" });
    await install("A-1.jar", { id: "x.a", version: "1" });

    const summary = await run(["x.a", "x.b"]);

    expect(await jarsIn(modsDir)).toEqual(["A-1.jar", "B-1.jar"]);
    expect(summary.kept).toEqual(["A-1.jar"]);
    expect(summary.copied).toEqual(["B-1.jar"]);
  });

  // Sets reference mod identity, not a jar version: Update All refreshes the
  // library and every world picks the new jar up at its next start.
  it("replaces an older jar of a wanted mod with the library's current one", async () => {
    await install("A-1.jar", { id: "x.a", version: "1" });
    await run(["x.a"]);
    // Update All lands a new version in the library.
    await library.add(
      await makeModJar(incoming, "A-2.jar", { id: "x.a", version: "2" }),
      { kind: "workshop", workshopId: "1" },
      "A-2.jar",
    );

    const summary = await run(["x.a"]);

    expect(await jarsIn(modsDir)).toEqual(["A-2.jar"]);
    expect(summary.removed).toEqual(["A-1.jar"]);
    expect(summary.copied).toEqual(["A-2.jar"]);
  });

  it("creates the mods folder when it is not there at all", async () => {
    await stock("A-1.jar", { id: "x.a", version: "1" });
    await rm(modsDir, { recursive: true });

    await run(["x.a"]);

    expect(await jarsIn(modsDir)).toEqual(["A-1.jar"]);
  });

  it("collapses a set that names the same mod twice", async () => {
    await stock("A-1.jar", { id: "x.a", version: "1" });
    const summary = await run(["x.a", "x.a"]);
    expect(summary.modIds).toEqual(["x.a"]);
    expect(await jarsIn(modsDir)).toEqual(["A-1.jar"]);
  });

  it("is a no-op the second time, doing no work and reporting none", async () => {
    await stock("A-1.jar", { id: "x.a", version: "1" });
    await run(["x.a"]);

    const again = await run(["x.a"]);

    expect(again).toMatchObject({ adopted: [], removed: [], copied: [], kept: ["A-1.jar"] });
  });
});

/*
 * Two mods whose current jars are named the same thing cannot both sit in the
 * mods folder - the second copy overwrites the first. `verify` would catch the
 * result, but only as "some mod is not there", which leaves an unstartable
 * world with no actionable diagnosis.
 */
describe("two library mods whose jars share a filename", () => {
  it("refuses before writing, naming both mods and the filename", async () => {
    await library.add(await makeModJar(join(incoming, "one"), "mod.jar", { id: "a.one" }), {
      kind: "local",
      how: "upload",
    });
    await library.add(await makeModJar(join(incoming, "two"), "mod.jar", { id: "b.two" }), {
      kind: "local",
      how: "upload",
    });

    await expect(run(["a.one", "b.two"])).rejects.toThrow(ReconcileError);
    await expect(run(["a.one", "b.two"])).rejects.toThrow(/a\.one/);
    await expect(run(["a.one", "b.two"])).rejects.toThrow(/b\.two/);
    await expect(run(["a.one", "b.two"])).rejects.toThrow(/mod\.jar/);
    expect(await jarsIn(modsDir)).toEqual([]);
  });

  it("is fine with either of them on its own", async () => {
    await library.add(await makeModJar(join(incoming, "one"), "mod.jar", { id: "a.one" }), {
      kind: "local",
      how: "upload",
    });
    await library.add(await makeModJar(join(incoming, "two"), "mod.jar", { id: "b.two" }), {
      kind: "local",
      how: "upload",
    });
    await run(["a.one"]);
    expect(await jarsIn(modsDir)).toEqual(["mod.jar"]);
  });
});

describe("installedModIds", () => {
  it("reports what the folder holds right now, one entry per mod", async () => {
    await install("A-1.jar", { id: "x.a", version: "1" });
    await install("A-2.jar", { id: "x.a", version: "2" });
    await install("B-1.jar", { id: "x.b", version: "1" });
    await writeFile(join(modsDir, "modlist.data"), "not a jar");

    expect((await installedModIds(modsDir)).sort()).toEqual(["x.a", "x.b"]);
  });

  it("is empty for a mods folder that does not exist", async () => {
    expect(await installedModIds(join(root, "nope"))).toEqual([]);
  });
});
