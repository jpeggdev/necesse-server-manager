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

/** Puts a jar straight into the mods folder, as steamcmd or a person would. */
const install = (filename: string, fields: Parameters<typeof makeModJar>[2], filler?: string): Promise<string> =>
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

  it("leaves a mod the library already holds alone rather than re-adopting it", async () => {
    await stock("A-2.jar", { id: "x.a", version: "2" });
    await install("A-1.jar", { id: "x.a", version: "1" });

    const summary = await run(["x.a"]);

    // The library's copy wins: a set follows the library, which is what makes
    // Update All reach every world.
    expect(summary.adopted).toEqual([]);
    expect(await jarsIn(modsDir)).toEqual(["A-2.jar"]);
    expect((await library.get("x.a"))?.version).toBe("2");
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

    expect(await jarsIn(modsDir)).toEqual(["Mod-1.2.0-7.10.jar"]);
    expect(summary.removed).toEqual(["Mod-1.2.0-7.7.jar"]);
    expect((await library.get("x.a"))?.version).toBe("7.10");
  });

  it("adopts the survivor before discarding the other", async () => {
    await install("Mod-1.jar", { id: "x.a", version: "1" }, "old");
    await install("Mod-2.jar", { id: "x.a", version: "2" }, "new");

    await run([]);

    expect(await jarsIn(modsDir)).toEqual([]);
    expect((await library.get("x.a"))?.version).toBe("2");
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
