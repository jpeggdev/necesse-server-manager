import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";

const ENV = "NECESSE_MANAGER_DATA";
const saved = process.env[ENV];
const savedProgramData = process.env.PROGRAMDATA;

afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  if (savedProgramData === undefined) delete process.env.PROGRAMDATA;
  else process.env.PROGRAMDATA = savedProgramData;
  vi.resetModules();
});

describe("stateDir", () => {
  it("uses NECESSE_MANAGER_DATA when set", async () => {
    process.env[ENV] = "D:\\somewhere\\else";
    vi.resetModules();
    const { stateDir } = await import("../src/state-dir.js");
    expect(stateDir()).toBe("D:\\somewhere\\else");
  });

  it("falls back to PROGRAMDATA when the override is absent", async () => {
    delete process.env[ENV];
    process.env.PROGRAMDATA = "C:\\ProgramData";
    vi.resetModules();
    const { stateDir } = await import("../src/state-dir.js");
    expect(stateDir()).toBe(join("C:\\ProgramData", "NecesseServerManager"));
  });

  it("throws naming both variables when neither is available", async () => {
    delete process.env[ENV];
    delete process.env.PROGRAMDATA;
    vi.resetModules();
    const { stateDir } = await import("../src/state-dir.js");
    expect(() => stateDir()).toThrow(/NECESSE_MANAGER_DATA/);
    expect(() => stateDir()).toThrow(/PROGRAMDATA/);
  });

  it("stateFile joins onto the state directory", async () => {
    process.env[ENV] = "D:\\state";
    vi.resetModules();
    const { stateFile } = await import("../src/state-dir.js");
    expect(stateFile("config.json")).toBe(join("D:\\state", "config.json"));
  });
});
