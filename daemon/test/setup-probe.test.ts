import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { generateToken, probeConfig } from "../src/setup-probe.js";

/** A fake filesystem: only the listed paths exist. */
const fsWith = (paths: string[]) => {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p: string) => Promise.resolve(set.has(p.toLowerCase()));
};

const APPDATA = "C:\\Users\\someone\\AppData\\Roaming";

describe("probeConfig", () => {
  it("finds the data directory under APPDATA", async () => {
    const dataDir = join(APPDATA, "Necesse");
    const r = await probeConfig({
      appData: APPDATA,
      pathDirs: [],
      extraServerRoots: [],
      exists: fsWith([dataDir]),
    });
    expect(r.dataDir).toBe(dataDir);
  });

  it("reports no data directory rather than guessing when APPDATA is unset", async () => {
    const r = await probeConfig({
      pathDirs: [],
      extraServerRoots: [],
      exists: fsWith([]),
    });
    expect(r.dataDir).toBeNull();
  });

  it("reports no data directory when APPDATA is set but Necesse is not underneath it", async () => {
    const r = await probeConfig({
      appData: APPDATA,
      pathDirs: [],
      extraServerRoots: [],
      exists: fsWith([]),
    });
    expect(r.dataDir).toBeNull();
  });

  it("finds the server root by the jar inside it, and prefers the bundled jre", async () => {
    const root = "C:\\necesseserver";
    const r = await probeConfig({
      pathDirs: ["C:\\Windows\\System32"],
      extraServerRoots: [root],
      exists: fsWith([
        join(root, "Server.jar"),
        join(root, "jre", "bin", "java.exe"),
        "C:\\Windows\\System32\\java.exe",
      ]),
    });
    expect(r.serverRoot).toBe(root);
    expect(r.serverJar).toBe(join(root, "Server.jar"));
    expect(r.javaExe).toBe(join(root, "jre", "bin", "java.exe"));
  });

  it("reports no server root when the candidate jar is not actually there", async () => {
    const root = "C:\\necesseserver";
    const r = await probeConfig({
      pathDirs: [],
      extraServerRoots: [root],
      exists: fsWith([]),
    });
    expect(r.serverRoot).toBeNull();
    expect(r.serverJar).toBeNull();
  });

  it("falls back to java on PATH when the server ships no jre", async () => {
    const root = "C:\\necesseserver";
    const onPath = "C:\\Java\\bin\\java.exe";
    const r = await probeConfig({
      pathDirs: ["C:\\Java\\bin"],
      extraServerRoots: [root],
      exists: fsWith([join(root, "Server.jar"), onPath]),
    });
    expect(r.javaExe).toBe(onPath);
  });

  it("finds steamcmd on PATH", async () => {
    const r = await probeConfig({
      pathDirs: ["C:\\steamcmd"],
      extraServerRoots: [],
      exists: fsWith(["C:\\steamcmd\\steamcmd.exe"]),
    });
    expect(r.steamcmdExe).toBe("C:\\steamcmd\\steamcmd.exe");
  });

  it("reports no steamcmd when the PATH candidate is not actually there", async () => {
    const r = await probeConfig({
      pathDirs: ["C:\\steamcmd"],
      extraServerRoots: [],
      exists: fsWith([]),
    });
    expect(r.steamcmdExe).toBeNull();
  });

  it("finds steamcmd under the user profile when it is not on PATH", async () => {
    const p = "C:\\Users\\someone\\steam\\steamcmd.exe";
    const r = await probeConfig({
      userProfile: "C:\\Users\\someone",
      pathDirs: [],
      extraServerRoots: [],
      exists: fsWith([p]),
    });
    expect(r.steamcmdExe).toBe(p);
  });

  it("returns null for everything it cannot find rather than a plausible guess", async () => {
    const r = await probeConfig({ pathDirs: [], extraServerRoots: [], exists: fsWith([]) });
    expect(r).toEqual({
      dataDir: null,
      serverRoot: null,
      serverJar: null,
      javaExe: null,
      steamcmdExe: null,
    });
  });
});

describe("generateToken", () => {
  it("is long, url-safe and different every time", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
