import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModLibrary } from "../src/mod-library.js";
import { ModRegistry } from "../src/mod-registry.js";
import { ModSets } from "../src/mod-sets.js";
import { migrateModSets } from "../src/mod-migration.js";
import { installedModIds } from "../src/mod-reconcile.js";
import { MOD_INFO_SUMMONER_EXPANSION, makeModJar, makeNonModJar } from "./fixtures/mod-jar.js";
import { makeWorldZip } from "./fixtures/world-zip.js";

let root: string;
let modsDir: string;
let worldsDir: string;
let cacheRoot: string;
let library: ModLibrary;
let sets: ModSets;
let registry: ModRegistry;

const workshopItemDir = (id: string): string => join(cacheRoot, id);

const migrate = (): ReturnType<typeof migrateModSets> =>
  migrateModSets({
    modsDir,
    worldsDir,
    library,
    sets,
    registry,
    workshopItemDir,
    log: () => {},
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-migrate-"));
  modsDir = join(root, "mods");
  worldsDir = join(root, "worlds");
  cacheRoot = join(root, "steam", "workshop");
  await mkdir(modsDir, { recursive: true });
  await mkdir(worldsDir, { recursive: true });
  library = new ModLibrary(join(root, "mod-library.json"), join(root, "mod-library"));
  sets = new ModSets(join(root, "mod-sets.json"));
  registry = new ModRegistry(join(root, "mods.json"));
});

/**
 * The live server's state on the day this was written: seven mods this app
 * installed, plus one hand-placed jar it knows nothing about.
 */
async function liveState(): Promise<void> {
  for (let i = 1; i <= 7; i++) {
    const jar = `Managed${i}-1.0.jar`;
    await makeModJar(modsDir, jar, { id: `vendor.managed${i}`, name: `Managed ${i}`, version: "1.0" });
    await registry.upsert({
      id: `100${i}`,
      name: `Managed ${i}`,
      jar,
      lastUpdated: "2026-07-01T00:00:00.000Z",
    });
  }
  await makeModJar(modsDir, "SummonerExpansion-1.2.0-7.7.jar", {}, {
    info: MOD_INFO_SUMMONER_EXPANSION,
  });
}

describe("seeding every world's set from what is installed now", () => {
  /*
   * The requirement the migration exists to satisfy: the first start after this
   * ships must load precisely what the previous start loaded. So the seeded set
   * has to be exactly the mods folder, jar for jar, untracked ones included.
   */
  it("produces a set identical to the current mods folder, for every world", async () => {
    await liveState();
    await makeWorldZip(worldsDir, "Summoner World");
    await makeWorldZip(worldsDir, "Tulsa What");

    const summary = await migrate();

    const inFolder = (await installedModIds(modsDir)).sort();
    expect(inFolder).toHaveLength(8);
    for (const world of ["Summoner World", "Tulsa What"]) {
      expect([...((await sets.get(world))?.modIds ?? [])].sort(), world).toEqual(inFolder);
    }
    expect(summary.seeded.sort()).toEqual(["Summoner World", "Tulsa What"]);
  });

  it("changes nothing in the mods folder", async () => {
    await liveState();
    await makeWorldZip(worldsDir, "Summoner World");
    const before = (await readdir(modsDir)).sort();

    await migrate();

    expect((await readdir(modsDir)).sort()).toEqual(before);
  });

  it("finds the world's set whatever case it is later asked for", async () => {
    await liveState();
    await makeWorldZip(worldsDir, "Summoner World");
    await migrate();
    expect(await sets.get("summoner world")).toBeDefined();
  });

  it("leaves a set somebody has already chosen exactly alone", async () => {
    await liveState();
    await makeWorldZip(worldsDir, "Summoner World");
    await sets.set("Summoner World", ["vendor.managed1"]);

    const summary = await migrate();

    expect((await sets.get("Summoner World"))?.modIds).toEqual(["vendor.managed1"]);
    expect(summary.seeded).toEqual([]);
  });

  it("seeds a world that appeared after the first run, and nothing else", async () => {
    await liveState();
    await makeWorldZip(worldsDir, "Summoner World");
    await migrate();

    await makeWorldZip(worldsDir, "Brand New");
    const second = await migrate();

    expect(second.seeded).toEqual(["Brand New"]);
    expect(second.adopted).toEqual([]);
  });
});

describe("seeding the library", () => {
  it("files a managed jar under its workshop id and a hand-placed one as local", async () => {
    await liveState();

    await migrate();

    const bySource = Object.fromEntries((await library.load()).map((m) => [m.id, m.source]));
    expect(bySource["vendor.managed1"]).toEqual({ kind: "workshop", workshopId: "1001" });
    expect(bySource["gagadoliano.summonerexpansion"]).toEqual({ kind: "local", how: "adopted" });
    expect(await library.load()).toHaveLength(8);
  });

  /*
   * The Aphorea case: installed through this app, then removed from the folder
   * by hand. steamcmd's cache still has the jar, so the library can offer it
   * back - but it is deliberately not added to any world's set, because it is
   * not what the server is loading right now.
   */
  it("recovers a managed mod that was taken out of the folder, without putting it in any set", async () => {
    await liveState();
    await registry.upsert({
      id: "2001",
      name: "Aphorea Mod",
      jar: "AphoreaMod-1.0.38.jar",
      lastUpdated: "2026-06-01T00:00:00.000Z",
    });
    await makeModJar(workshopItemDir("2001"), "AphoreaMod-1.0.38.jar", {
      id: "aphoreateam.aphoreamod",
      name: "Aphorea Mod",
      version: "1.0.38",
    });
    await makeWorldZip(worldsDir, "Summoner World");

    const summary = await migrate();

    expect(summary.recovered).toEqual(["aphoreateam.aphoreamod"]);
    expect(await library.resolve("aphoreateam.aphoreamod")).toBeDefined();
    expect((await sets.get("Summoner World"))?.modIds).not.toContain("aphoreateam.aphoreamod");
  });

  it("is quiet when a managed mod has no cached jar to recover", async () => {
    await registry.upsert({
      id: "2001",
      name: "Gone",
      jar: "Gone-1.0.jar",
      lastUpdated: "2026-06-01T00:00:00.000Z",
    });
    const summary = await migrate();
    expect(summary.recovered).toEqual([]);
    expect(summary.skipped).toEqual([]);
  });

  it("adds nothing on a second run", async () => {
    await liveState();
    await makeWorldZip(worldsDir, "Summoner World");
    await migrate();
    const first = await library.load();

    const second = await migrate();

    expect(second.adopted).toEqual([]);
    expect(second.recovered).toEqual([]);
    expect(await library.load()).toEqual(first);
  });
});

describe("things that are not mods", () => {
  /*
   * This runs at daemon boot. Refusing to start the daemon over one stray file
   * in the mods folder helps nobody - but the file is reported, never silently
   * dropped, and the world's set cannot name it, so the first start of that
   * world still refuses rather than launching a folder holding it.
   */
  it("reports a jar it cannot account for instead of taking the daemon down", async () => {
    await makeNonModJar(modsDir, "Mystery.jar");
    await makeModJar(modsDir, "Real-1.jar", { id: "x.real", version: "1" });
    await makeWorldZip(worldsDir, "Tulsa What");

    const summary = await migrate();

    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]).toMatch(/Mystery\.jar/);
    expect(summary.adopted).toEqual(["x.real"]);
    expect((await sets.get("Tulsa What"))?.modIds).toEqual(["x.real"]);
  });

  it("ignores files in the mods folder that are not jars", async () => {
    await writeFile(join(modsDir, "modlist.data"), "the game's own file");
    await makeWorldZip(worldsDir, "Tulsa What");

    const summary = await migrate();

    expect(summary.skipped).toEqual([]);
    expect((await sets.get("Tulsa What"))?.modIds).toEqual([]);
  });
});

describe("an empty box", () => {
  it("does nothing at all with no worlds and no mods", async () => {
    expect(await migrate()).toEqual({ adopted: [], recovered: [], seeded: [], skipped: [] });
  });

  it("gives a world an empty set when nothing is installed", async () => {
    await makeWorldZip(worldsDir, "Vanilla");
    await migrate();
    expect((await sets.get("Vanilla"))?.modIds).toEqual([]);
  });
});
