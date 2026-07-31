import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  configProblems,
  fatalProblems,
  loadConfig,
  modsDirFor,
  resolveBootConfig,
  saveConfig,
  worldsDirFor,
} from "../src/config.js";
import { makeTestConfig } from "./fixtures/test-config.js";

let root: string;
let state: string;
const savedStateEnv = process.env.NECESSE_MANAGER_DATA;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-config-"));
  // Pins where stateDir() resolves to for this file, so the state-derived paths
  // are a known value rather than this machine's %PROGRAMDATA%.
  state = join(root, "state");
  process.env.NECESSE_MANAGER_DATA = state;
});

afterEach(async () => {
  if (savedStateEnv === undefined) delete process.env.NECESSE_MANAGER_DATA;
  else process.env.NECESSE_MANAGER_DATA = savedStateEnv;
  await rm(root, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("throws naming the directory when no config exists, and creates nothing", async () => {
    const file = join(root, "config.json");
    await expect(loadConfig(file)).rejects.toThrow(root);
    await expect(loadConfig(file)).rejects.toThrow(/setup/i);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives modsDir and worldsDir from dataDir, ignoring what the file said", async () => {
    const file = join(root, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        dataDir: "C:\\Data\\Necesse",
        modsDir: "D:\\somewhere\\stale",
        worldsDir: "D:\\somewhere\\also-stale",
      }),
      "utf8",
    );
    const cfg = await loadConfig(file);
    expect(cfg.modsDir).toBe(modsDirFor("C:\\Data\\Necesse"));
    expect(cfg.worldsDir).toBe(worldsDirFor("C:\\Data\\Necesse"));
  });

  /**
   * The exact shape every install predating the state directory has on disk:
   * `saveConfig` used to write these three, and they used to default to the
   * install directory. If a stored value wins, the daemon reads its mod library
   * out of a directory the upgrade instructions tell the operator to delete -
   * and `ModLibrary.load()` reports the resulting missing manifest as an empty
   * library rather than as a failure, so nothing anywhere says the jars are
   * gone.
   */
  it("ignores install-directory values for the state-derived paths", async () => {
    const file = join(root, "config.json");
    const installDir = "C:\\Users\\someone\\necesse-daemon";
    await writeFile(
      file,
      JSON.stringify({
        dataDir: "C:\\Data\\Necesse",
        modLibraryDir: join(installDir, "mod-library"),
        modLibraryFile: join(installDir, "mod-library.json"),
        modSetsFile: join(installDir, "mod-sets.json"),
      }),
      "utf8",
    );

    const cfg = await loadConfig(file);

    for (const value of [cfg.modLibraryDir, cfg.modLibraryFile, cfg.modSetsFile]) {
      expect(value).not.toContain(installDir);
    }
    expect(cfg.modLibraryDir).toBe(join(state, "mod-library"));
    expect(cfg.modLibraryFile).toBe(join(state, "mod-library.json"));
    expect(cfg.modSetsFile).toBe(join(state, "mod-sets.json"));
  });

  it("tolerates a BOM", async () => {
    const file = join(root, "config.json");
    await writeFile(file, "\uFEFF" + JSON.stringify({ port: 9999 }), "utf8");
    expect((await loadConfig(file)).port).toBe(9999);
  });

  it("reports a parse failure with the path rather than defaulting", async () => {
    const file = join(root, "config.json");
    await writeFile(file, "{ not json", "utf8");
    await expect(loadConfig(file)).rejects.toThrow(file);
  });
});

describe("saveConfig", () => {
  it("omits the derived directories so a saved config cannot carry a stale copy", async () => {
    const file = join(root, "config.json");
    await saveConfig(file, makeTestConfig(root));
    const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    for (const key of [
      "modsDir",
      "worldsDir",
      "modLibraryDir",
      "modLibraryFile",
      "modSetsFile",
    ]) {
      expect(written).not.toHaveProperty(key);
    }
    expect(written.dataDir).toBe(join(root, "data"));
  });
});

describe("DEFAULT_CONFIG", () => {
  it("carries no machine-specific paths", async () => {
    for (const key of [
      "dataDir",
      "serverRoot",
      "javaExe",
      "serverJar",
      "steamcmdExe",
      "modLibraryDir",
      "modLibraryFile",
      "modSetsFile",
    ] as const) {
      expect(DEFAULT_CONFIG[key]).toBe("");
    }
  });

  it("leaves authentication disabled by default so an older config still boots", () => {
    expect(DEFAULT_CONFIG.authToken).toBe("");
  });
});

describe("configProblems", () => {
  it("is empty for a coherent config whose paths exist", async () => {
    expect(await configProblems(makeTestConfig(root), {})).toEqual([]);
  });

  it("is fatal for each required path left empty, reporting all of them at once", async () => {
    const cfg = { ...makeTestConfig(root), serverJar: "", javaExe: "" };
    const problems = await configProblems(cfg, {});
    const keys = problems.filter((p) => p.fatal).map((p) => p.key);
    expect(keys).toContain("serverJar");
    expect(keys).toContain("javaExe");
  });

  it("is fatal when a required path is set but absent from disk", async () => {
    const cfg = { ...makeTestConfig(root), serverJar: join(root, "nope", "Server.jar") };
    const problems = await configProblems(cfg, {});
    expect(problems.some((p) => p.key === "serverJar" && p.fatal)).toBe(true);
  });

  it("warns rather than refuses when steamcmd is missing", async () => {
    const cfg = { ...makeTestConfig(root), steamcmdExe: join(root, "nope", "steamcmd.exe") };
    const problems = await configProblems(cfg, {});
    const steam = problems.find((p) => p.key === "steamcmdExe");
    expect(steam).toBeDefined();
    expect(steam?.fatal).toBe(false);
    expect(fatalProblems(problems)).toEqual([]);
  });

  it("does not treat an empty authToken as a problem", async () => {
    const problems = await configProblems({ ...makeTestConfig(root), authToken: "" }, {});
    expect(problems.some((p) => p.key === "authToken")).toBe(false);
  });

  it("is fatal when a legacy stored modsDir disagrees with dataDir", async () => {
    const cfg = makeTestConfig(root);
    const problems = await configProblems(cfg, { modsDir: "C:\\Users\\someoneelse\\mods" });
    const drift = problems.find((p) => p.key === "modsDir");
    expect(drift?.fatal).toBe(true);
    expect(drift?.message).toContain("C:\\Users\\someoneelse\\mods");
  });

  it("is fatal when a legacy stored worldsDir disagrees with dataDir", async () => {
    const cfg = makeTestConfig(root);
    const problems = await configProblems(cfg, { worldsDir: "C:\\Users\\someoneelse\\worlds" });
    const drift = problems.find((p) => p.key === "worldsDir");
    expect(drift?.fatal).toBe(true);
    expect(drift?.message).toContain("C:\\Users\\someoneelse\\worlds");
  });

  it("accepts a legacy stored modsDir that agrees, allowing for case and separators", async () => {
    const cfg = makeTestConfig(root);
    const problems = await configProblems(cfg, {
      modsDir: cfg.modsDir.toLowerCase().replace(/\\/g, "/") + "\\",
      worldsDir: cfg.worldsDir,
    });
    expect(problems.some((p) => p.key === "modsDir" || p.key === "worldsDir")).toBe(false);
  });
});

// See resolveBootConfig's own doc comment in config.ts for why this drives it
// from a real file on disk rather than a hand-built `stored` object.
describe("resolveBootConfig", () => {
  it("refuses to resolve when config.json on disk still carries a stale modsDir", async () => {
    const cfg = makeTestConfig(root);
    const file = join(root, "config.json");
    // Written by hand, not via saveConfig: saveConfig deliberately omits
    // modsDir/worldsDir, which is exactly why a legacy file that still has
    // one is the case worth pinning here.
    await writeFile(
      file,
      JSON.stringify({ ...cfg, modsDir: "C:\\Users\\someoneelse\\mods" }),
      "utf8",
    );

    const result = await resolveBootConfig(root);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("modsDir");
      expect(result.message).toContain("C:\\Users\\someoneelse\\mods");
    }
  });

  it("resolves cleanly when the stored config's dirs agree with dataDir", async () => {
    const cfg = makeTestConfig(root);
    const file = join(root, "config.json");
    await saveConfig(file, cfg);

    const result = await resolveBootConfig(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configFile).toBe(file);
      expect(result.cfg.modsDir).toBe(cfg.modsDir);
      expect(result.cfg.worldsDir).toBe(cfg.worldsDir);
      expect(result.configWarnings).toEqual([]);
    }
  });

  /**
   * The non-fatal half of `configProblems` has exactly one carrier: the
   * `problems.filter(...).map(...)` that becomes `configWarnings`. Replacing
   * that expression with `[]` left the whole daemon suite green, because every
   * other test of it calls `configProblems` directly and never looks at what
   * `resolveBootConfig` does with the result. "steamcmd was not found" reaching
   * the operator depends on that one line, so it is asserted here.
   */
  it("resolves ok but carries the steamcmd warning through to the caller", async () => {
    const cfg = { ...makeTestConfig(root), steamcmdExe: join(root, "nope", "steamcmd.exe") };
    await saveConfig(join(root, "config.json"), cfg);

    const result = await resolveBootConfig(root);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configWarnings.some((w) => w.includes("steamcmdExe"))).toBe(true);
      expect(result.configWarnings.some((w) => w.includes(cfg.steamcmdExe))).toBe(true);
    }
  });
});
