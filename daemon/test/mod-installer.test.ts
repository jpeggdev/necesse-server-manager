import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ModInstaller } from "../src/mod-installer.js";
import { ModRegistry } from "../src/mod-registry.js";
import { SteamCmd } from "../src/steamcmd.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { DaemonConfig } from "../src/types.js";

let modsDir: string;
let steamRoot: string;
let cfg: DaemonConfig;
let registry: ModRegistry;
let steam: SteamCmd;
let installer: ModInstaller;

/** Places a jar where steamcmd would have downloaded it, then reports success. */
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
    await writeFile(join(dir, jar), "jarbytes");
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
});

function build(jars: Record<string, string | null>): ModInstaller {
  steam = fakeSteam(jars);
  installer = new ModInstaller(cfg, registry, steam);
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
    // A *file* at the download-dir path (rather than a missing dir) forces ENOTDIR, not ENOENT.
    await mkdir(dirname(dir), { recursive: true });
    await writeFile(dir, "not a directory");
    vi.spyOn(steam, "downloadWorkshopItem").mockResolvedValue({
      ok: true,
      exitCode: 0,
      output: "Success.",
    });
    const r = await inst.install("777", "Weird", () => {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot read/i);
    expect(r.error).not.toMatch(/no \.jar/i);
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
