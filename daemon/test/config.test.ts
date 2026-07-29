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
  saveConfig,
  worldsDirFor,
} from "../src/config.js";
import { makeTestConfig } from "./fixtures/test-config.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-config-"));
});

afterEach(async () => {
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
    expect(written).not.toHaveProperty("modsDir");
    expect(written).not.toHaveProperty("worldsDir");
    expect(written.dataDir).toBe(join(root, "data"));
  });
});

describe("DEFAULT_CONFIG", () => {
  it("carries no machine-specific paths", async () => {
    for (const key of ["dataDir", "serverRoot", "javaExe", "serverJar", "steamcmdExe"] as const) {
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
