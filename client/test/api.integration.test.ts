// Cross-package seam test: exercises the real daemon HTTP body parser, not a
// mocked fetch. A test that only asserts which headers fetch() was called
// with cannot catch a Content-Type/body mismatch that Fastify's real parser
// rejects - this test stands up an actual (in-process, ephemeral-port)
// daemon instance against temp directories and a fake spawn, then drives it
// with the real makeApi() over real HTTP. Never point this at the live
// daemon on the LAN - temp dirs + a fake spawn only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../daemon/src/http.js";
import { ProcessManager } from "../../daemon/src/process-manager.js";
import { ModInstaller } from "../../daemon/src/mod-installer.js";
import { ModRegistry } from "../../daemon/src/mod-registry.js";
import { SteamCmd } from "../../daemon/src/steamcmd.js";
import { DEFAULT_CONFIG } from "../../daemon/src/config.js";
import { makeFakeSpawn } from "../../daemon/test/fixtures/fake-spawn.js";
import { makeApi } from "../src/api";

let app: ReturnType<typeof buildServer>;
let baseUrl: string;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-client-http-"));
  const modsDir = join(root, "mods");
  const worldsDir = join(root, "worlds");
  await mkdir(modsDir, { recursive: true });
  await mkdir(worldsDir, { recursive: true });
  const cfg = { ...DEFAULT_CONFIG, modsDir, worldsDir, stopTimeoutMs: 50 };
  const configFile = join(root, "config.json");
  const spawn = makeFakeSpawn();
  const pm = new ProcessManager(cfg, spawn.spawn);
  const steam = new SteamCmd(cfg, spawn.spawn);
  const installer = new ModInstaller(cfg, new ModRegistry(join(root, "mods.json")), steam);
  app = buildServer({ cfg, configFile, pm, installer, steam });
  baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  // try/finally so a throwing app.close() can't strand the temp dir, and a
  // failing rm() can't skip closing the listener.
  try {
    await app.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("makeApi against a real daemon instance", () => {
  it("stop() reaches the route handler instead of 400ing on an empty JSON body", async () => {
    await expect(makeApi(baseUrl).stop()).rejects.toThrow(/not running/i);
  });

  it("kill() reaches the route handler instead of 400ing on an empty JSON body", async () => {
    await expect(makeApi(baseUrl).kill()).rejects.toThrow(/no managed server/i);
  });

  it("updateServer() reaches the route handler instead of 400ing on an empty JSON body", async () => {
    const res = await makeApi(baseUrl).updateServer();
    expect(res.ok).toBe(true);
    expect(typeof res.taskId).toBe("string");
  });

  it("updateAllMods() reaches the route handler instead of 400ing on an empty JSON body", async () => {
    const res = await makeApi(baseUrl).updateAllMods();
    expect(res.ok).toBe(true);
    expect(typeof res.taskId).toBe("string");
  });

  it("removeMod() (bodyless DELETE) reaches the route handler instead of 400ing", async () => {
    // Same root cause, same request() codepath, different verb: confirm the
    // fix isn't accidentally POST-specific.
    await expect(makeApi(baseUrl).removeMod("999")).rejects.toThrow(/not managed/i);
  });
});
