import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "../src/config.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "necesse-cfg-"));
}

describe("config", () => {
  it("returns defaults and writes the file when it does not exist", async () => {
    const file = join(await tmp(), "config.json");
    const cfg = await loadConfig(file);
    expect(cfg.port).toBe(8710);
    expect(cfg.serverAppId).toBe(1169370);
    expect(cfg.workshopAppId).toBe(1169040);
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written.port).toBe(8710);
    // Never a real key in the defaults, the seed, or anything written from them.
    expect(cfg.steamApiKey).toBe("");
    expect(written.steamApiKey).toBe("");
  });

  it("gives an existing config with no steamApiKey the empty default rather than undefined", async () => {
    // The live config.json predates the field; publicConfig() calls .trim() on
    // it, so an undefined here would throw on every GET /api/config.
    const file = join(await tmp(), "config.json");
    await writeFile(file, JSON.stringify({ owners: ["Jeff"] }));
    expect((await loadConfig(file)).steamApiKey).toBe("");
  });

  it("merges a partial file over defaults so new keys gain defaults", async () => {
    const file = join(await tmp(), "config.json");
    await writeFile(file, JSON.stringify({ owners: ["Jeff", "Eli"], port: 9000 }));
    const cfg = await loadConfig(file);
    expect(cfg.owners).toEqual(["Jeff", "Eli"]);
    expect(cfg.port).toBe(9000);
    expect(cfg.stopTimeoutMs).toBe(DEFAULT_CONFIG.stopTimeoutMs);
  });

  it("round-trips through save", async () => {
    const file = join(await tmp(), "config.json");
    const cfg = { ...DEFAULT_CONFIG, lastWorld: "Infected Toenail" };
    await saveConfig(file, cfg);
    expect((await loadConfig(file)).lastWorld).toBe("Infected Toenail");
  });

  it("loads a config written with a UTF-8 BOM, as Windows editors produce", async () => {
    // Notepad, VS Code and PowerShell's `Set-Content -Encoding UTF8` all emit a
    // BOM. Hand-editing this file on the server is the documented way to set the
    // Steam key, and a BOM used to stop the daemon booting at all.
    const file = join(await tmp(), "config.json");
    const bom = String.fromCharCode(0xfeff);
    await writeFile(file, bom + JSON.stringify({ owners: ["Jeff"], steamApiKey: "abc" }), "utf8");
    const cfg = await loadConfig(file);
    expect(cfg.owners).toEqual(["Jeff"]);
    expect(cfg.steamApiKey).toBe("abc");
    expect(cfg.port).toBe(DEFAULT_CONFIG.port);
  });

  it("throws with the file path in the message on malformed JSON", async () => {
    const file = join(await tmp(), "config.json");
    await writeFile(file, "{ not json");
    await expect(loadConfig(file)).rejects.toThrow(file);
  });

  it("propagates a non-ENOENT read error instead of overwriting with defaults", async () => {
    const dir = await tmp();
    await expect(loadConfig(dir)).rejects.toThrow(dir);
  });
});
