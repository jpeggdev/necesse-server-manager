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

  it("throws with the file path in the message on malformed JSON", async () => {
    const file = join(await tmp(), "config.json");
    await writeFile(file, "{ not json");
    await expect(loadConfig(file)).rejects.toThrow(file);
  });
});
