import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { reconcileMods } from "../src/mod-reconcile.js";
import { ModInstaller } from "../src/mod-installer.js";
import { ModLibrary } from "../src/mod-library.js";
import { ModRegistry } from "../src/mod-registry.js";
import { SteamCmd } from "../src/steamcmd.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { makeModJar } from "./fixtures/mod-jar.js";
import type { DaemonConfig } from "../src/types.js";

let modsDir: string;
let steamRoot: string;
let cfg: DaemonConfig;
let registry: ModRegistry;
let library: ModLibrary;
let steam: SteamCmd;
let installer: ModInstaller;

/** The mod id a jar downloaded for workshop item `id` declares in its mod.info. */
const modIdFor = (id: string): string => `vendor.mod${id}`;

/**
 * Places a jar where steamcmd would have downloaded it, then reports success.
 *
 * A REAL jar, with a real `mod.info` inside it: the installer now files every
 * download into the mod library, which reads that file, so a stub of a few bytes
 * would be rejected as not a Necesse mod and the test would be exercising the
 * failure path while claiming to test the success one.
 */
function fakeSteam(jarByModId: Record<string, string | null>): SteamCmd {
  const s = new SteamCmd(cfg, (() => {
    throw new Error("spawn should not be called");
  }) as never);
  vi.spyOn(s, "downloadWorkshopItem").mockImplementation(async (id: string) => {
    const jar = jarByModId[id];
    if (jar === null || jar === undefined) {
      return { ok: false, exitCode: 8, output: `ERROR! Download item ${id} failed (Failure).` };
    }
    const dir = s.workshopItemDir(id);
    await mkdir(dir, { recursive: true });
    await makeModJar(dir, jar, { id: modIdFor(id), name: `Mod ${id}`, version: "1.0" }, {
      // Distinct bytes per filename, so "the library holds these exact bytes" is
      // a claim with teeth when a version bump renames the jar.
      filler: jar,
    });
    return { ok: true, exitCode: 0, output: `Success. Downloaded item ${id}` };
  });
  return s;
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "necesse-inst-"));
  modsDir = join(root, "mods");
  steamRoot = join(root, "steam");
  await mkdir(modsDir, { recursive: true });
  await mkdir(steamRoot, { recursive: true });
  cfg = { ...DEFAULT_CONFIG, modsDir, steamcmdExe: join(steamRoot, "steamcmd.exe") };
  registry = new ModRegistry(join(root, "mods.json"));
  library = new ModLibrary(join(root, "mod-library.json"), join(root, "mod-library"));
});

function build(jars: Record<string, string | null>): ModInstaller {
  steam = fakeSteam(jars);
  installer = new ModInstaller(cfg, registry, steam, library);
  return installer;
}

describe("install", () => {
  it("copies the downloaded jar into the mods dir and records it", async () => {
    const inst = build({ "3731244177": "SafeHavenQOL-1.2.0-2.6.jar" });
    const r = await inst.install("3731244177", "Safe Haven QOL", () => {});
    expect(r.ok).toBe(true);
    expect(await readdir(modsDir)).toEqual(["SafeHavenQOL-1.2.0-2.6.jar"]);
    expect((await registry.get("3731244177"))?.jar).toBe("SafeHavenQOL-1.2.0-2.6.jar");
  });

  it("deletes the previously recorded jar when the version filename changes", async () => {
    await build({ "3731244177": "SafeHavenQOL-1.2.0-2.6.jar" }).install("3731244177", "Safe Haven QOL", () => {});
    const r = await build({ "3731244177": "SafeHavenQOL-1.2.0-2.7.jar" }).install(
      "3731244177",
      "Safe Haven QOL",
      () => {},
    );
    expect(await readdir(modsDir)).toEqual(["SafeHavenQOL-1.2.0-2.7.jar"]);
    expect(r.replacedJar).toBe("SafeHavenQOL-1.2.0-2.6.jar");
  });

  it("fails with steamcmd's output and writes nothing when the download fails", async () => {
    const r = await build({ "999": null }).install("999", "Nope", () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ERROR! Download item 999 failed");
    expect(await readdir(modsDir)).toEqual([]);
    expect(await registry.get("999")).toBeUndefined();
  });

  it("fails clearly when the download produced no jar", async () => {
    const inst = build({});
    vi.spyOn(steam, "downloadWorkshopItem").mockResolvedValue({
      ok: true,
      exitCode: 0,
      output: "Success.",
    });
    const r = await inst.install("555", "Ghost", () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no \.jar/i);
  });

  it("adopts an untracked jar when its filename matches the download", async () => {
    await writeFile(join(modsDir, "AutoTorch-1.0.jar"), "old");
    const inst = build({ "3754847143": "AutoTorch-1.0.jar" });
    await inst.install("3754847143", "AutoTorch", () => {});
    const list = await inst.list();
    expect(list.untracked).toEqual([]);
    expect(list.managed.map((m) => m.id)).toEqual(["3754847143"]);
  });

  it("propagates a non-ENOENT error reading steamcmd's download dir instead of a generic no-jar result", async () => {
    const inst = build({});
    const dir = steam.workshopItemDir("777");
    // install() clears `dir` before calling steamcmd, so a file placed there beforehand
    // would just be wiped away. Simulate the download itself leaving a *file* at the
    // dir path (rather than a directory) instead, which forces ENOTDIR, not ENOENT,
    // when install() reads it back afterward.
    vi.spyOn(steam, "downloadWorkshopItem").mockImplementation(async () => {
      await mkdir(dirname(dir), { recursive: true });
      await writeFile(dir, "not a directory");
      return { ok: true, exitCode: 0, output: "Success." };
    });
    const r = await inst.install("777", "Weird", () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot read/i);
    expect(r.error).not.toMatch(/no \.jar/i);
  });

  it("clears the item's previous download output before fetching again, so a stale jar under the old filename can't be mistaken for the new one", async () => {
    const inst = build({ "42": "NewName-2.0.jar" });
    const dir = steam.workshopItemDir("42");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "OldName-1.0.jar"), "stale");
    const r = await inst.install("42", "Thing", () => {});
    expect(r.ok).toBe(true);
    expect(r.jar).toBe("NewName-2.0.jar");
    expect(await readdir(dir)).toEqual(["NewName-2.0.jar"]);
    expect(await readdir(modsDir)).toEqual(["NewName-2.0.jar"]);
  });

  it("tolerates a first-time install with no pre-existing workshop item directory", async () => {
    const inst = build({ "42": "Something-1.0.jar" });
    await expect(readdir(steam.workshopItemDir("42"))).rejects.toThrow();
    const r = await inst.install("42", "Thing", () => {});
    expect(r.ok).toBe(true);
  });

  it("fails clearly, touching neither the mods folder nor the registry, when steamcmd's download produces more than one jar", async () => {
    const inst = build({});
    vi.spyOn(steam, "downloadWorkshopItem").mockImplementation(async (id: string) => {
      const dir = steam.workshopItemDir(id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "One.jar"), "a");
      await writeFile(join(dir, "Two.jar"), "b");
      return { ok: true, exitCode: 0, output: "Success." };
    });
    const r = await inst.install("88", "Weird", () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain("One.jar");
    expect(r.error).toContain("Two.jar");
    expect(await readdir(modsDir)).toEqual([]);
    expect(await registry.get("88")).toBeUndefined();
  });
});

/*
 * The library is what reconcile applies a world's set from, so an install that
 * wrote only the mods folder was silently reverted at the next start: reconcile
 * deleted the freshly downloaded jar and restored the older one, with no
 * message. That is decision row 1 of docs/mod-sets-design.md - "Update All
 * refreshes the library and every world picks the new version up at its next
 * start" - and these are the tests that hold it up.
 */
describe("installing writes the library, so reconcile does not undo it", () => {
  it("files the download as that mod's current jar", async () => {
    const inst = build({ "3731244177": "SafeHavenQOL-1.2.0-2.6.jar" });
    await inst.install("3731244177", "Safe Haven QOL", () => {});

    const entry = await library.get(modIdFor("3731244177"));
    expect(entry?.jar).toBe("SafeHavenQOL-1.2.0-2.6.jar");
    expect(entry?.source).toEqual({ kind: "workshop", workshopId: "3731244177" });
    expect(await readFile(library.jarPath(entry!))).toEqual(
      await readFile(join(modsDir, "SafeHavenQOL-1.2.0-2.6.jar")),
    );
  });

  it("survives the reconcile that follows: the NEW jar is what the world starts with", async () => {
    // The state after migration: v2.6 installed, and a world set to load it.
    await build({ "3731244177": "SafeHavenQOL-1.2.0-2.6.jar" }).install("3731244177", "Safe Haven QOL", () => {});
    const modId = modIdFor("3731244177");

    // Update All lands v2.7.
    const update = await build({ "3731244177": "SafeHavenQOL-1.2.0-2.7.jar" }).updateAll(() => {});
    expect(update.every((r) => r.ok)).toBe(true);

    // ...and the next start reconciles the folder to the set.
    await reconcileMods({ modsDir, library, world: "Tulsa", modIds: [modId], log: () => {} });

    expect(await readdir(modsDir)).toEqual(["SafeHavenQOL-1.2.0-2.7.jar"]);
    expect((await library.get(modId))?.jar).toBe("SafeHavenQOL-1.2.0-2.7.jar");
    // The version it replaced is retained, not destroyed.
    expect((await library.get(modId))?.superseded.map((j) => j.jar)).toEqual([
      "SafeHavenQOL-1.2.0-2.6.jar",
    ]);
  });

  it("fails the install rather than leaving a jar the next start would revert", async () => {
    const inst = build({ "42": "Thing-1.jar" });
    vi.spyOn(library, "add").mockRejectedValue(new Error("disk full"));

    const r = await inst.install("42", "Thing", () => {});

    expect(r.ok).toBe(false);
    expect(r.error).toContain("disk full");
    expect(r.error).toMatch(/undone at the next start/);
    // Not recorded as installed, so nothing claims a mod the library lacks.
    expect(await registry.get("42")).toBeUndefined();
  });
});

describe("list", () => {
  it("separates managed entries from untracked jars", async () => {
    const inst = build({ "3754847143": "AutoTorch-1.0.jar" });
    await inst.install("3754847143", "AutoTorch", () => {});
    await writeFile(join(modsDir, "MysteryMod.jar"), "x");
    await writeFile(join(modsDir, "modlist.data"), "not a jar");
    const list = await inst.list();
    expect(list.managed.map((m) => m.name)).toEqual(["AutoTorch"]);
    expect(list.untracked).toEqual([{ jar: "MysteryMod.jar" }]);
  });

  it("reports a managed mod whose jar has vanished from disk as untracked-free but still managed", async () => {
    const inst = build({ "3754847143": "AutoTorch-1.0.jar" });
    await inst.install("3754847143", "AutoTorch", () => {});
    const list = await inst.list();
    expect(list.managed).toHaveLength(1);
  });

  it("returns an empty untracked list when the mods directory is missing", async () => {
    cfg.modsDir = join(modsDir, "nope");
    const inst = build({});
    expect(await inst.list()).toEqual({ managed: [], untracked: [] });
  });

  it("propagates a non-ENOENT error instead of returning an empty list", async () => {
    const notADir = join(modsDir, "not-really-a-dir");
    await writeFile(notADir, "x");
    cfg.modsDir = notADir;
    const inst = build({});
    await expect(inst.list()).rejects.toThrow(notADir);
  });
});

describe("updateAll", () => {
  it("continues past a failing mod and reports each result", async () => {
    await build({ "1": "A-1.jar" }).install("1", "A", () => {});
    await build({ "2": "B-1.jar" }).install("2", "B", () => {});
    const inst = build({ "1": null, "2": "B-2.jar" });
    const results = await inst.updateAll(() => {});
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.id === "1")?.ok).toBe(false);
    expect(results.find((r) => r.id === "2")?.ok).toBe(true);
    const files = await readdir(modsDir);
    expect(files).toContain("A-1.jar");
    expect(files).toContain("B-2.jar");
    expect(files).not.toContain("B-1.jar");
  });

  it("returns an empty array when nothing is managed", async () => {
    expect(await build({}).updateAll(() => {})).toEqual([]);
  });
});

describe("remove", () => {
  it("deletes the jar and the registry entry", async () => {
    const inst = build({ "3754847143": "AutoTorch-1.0.jar" });
    await inst.install("3754847143", "AutoTorch", () => {});
    await inst.remove("3754847143");
    expect(await readdir(modsDir)).toEqual([]);
    expect(await registry.get("3754847143")).toBeUndefined();
  });

  it("throws for an unknown id", async () => {
    await expect(build({}).remove("nope")).rejects.toThrow(/not managed/i);
  });
});
