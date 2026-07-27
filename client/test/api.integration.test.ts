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
import { SteamWorkshop } from "../../daemon/src/steam-workshop.js";
import { DEFAULT_CONFIG } from "../../daemon/src/config.js";
import { makeFakeSpawn } from "../../daemon/test/fixtures/fake-spawn.js";
import { makeWorldZip } from "../../daemon/test/fixtures/world-zip.js";
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
  // Same rule as the fake spawn: this test stands up a real daemon, so its
  // fetch is stubbed to refuse rather than reach Steam. Anything that tries
  // fails loudly instead of quietly making a live call from the test suite.
  const workshop = new SteamWorkshop(cfg, () =>
    Promise.reject(new Error("no network in tests")),
  );
  app = buildServer({ cfg, configFile, pm, installer, steam, workshop });
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

/*
 * PUT is a verb no other call in this client uses, and the settings form is the
 * only thing that sends a JSON body through `request()` on anything but POST.
 * A mocked fetch would prove the header was set and nothing about whether
 * Fastify accepts it, which is exactly the failure this file exists for - so
 * this drives a real daemon over real HTTP against a real world zip in a temp
 * directory.
 */
describe("world settings over a real daemon instance", () => {
  it("reads the file's own keys, types and option sets", async () => {
    await makeWorldZip(join(root, "worlds"), "Tulsa");
    const res = await makeApi(baseUrl).worldSettings("Tulsa");

    const difficulty = res.fields.find((f) => f.key === "difficulty");
    // The option set the form renders comes from here, not from the client.
    expect(difficulty?.options).toContain("BRUTAL");
    expect(res.fields.find((f) => f.key === "gameVersion")?.editable).toBe(false);
    const modKey = res.fields.find((f) => f.key === "rpgskillsWorldStackLevel");
    expect(modKey?.type).toBeNull();
    expect(modKey?.editable).toBe(false);
  });

  it("applies a partial change and reports where the backup went", async () => {
    await makeWorldZip(join(root, "worlds"), "Tulsa");
    const api = makeApi(baseUrl);
    const res = await api.saveWorldSettings("Tulsa", { allowCheats: true, difficulty: "BRUTAL" });

    expect(res.changed).toEqual(["allowCheats", "difficulty"]);
    expect(res.backup).toMatch(/Tulsa/);
    expect(res.fields.find((f) => f.key === "allowCheats")?.value).toBe("true");
    // Untouched by this write, and still there: the whole point of sending a
    // partial patch rather than the form.
    expect(res.fields.find((f) => f.key === "survivalMode")?.value).toBe("true");
    expect(res.fields.find((f) => f.key === "rpgskillsWorldStackLevel")?.value).toBe("1");
  });

  it("writes nothing, and takes no backup, when the values already match", async () => {
    await makeWorldZip(join(root, "worlds"), "Tulsa");
    const res = await makeApi(baseUrl).saveWorldSettings("Tulsa", { allowCheats: false });
    expect(res.changed).toEqual([]);
    expect(res.backup).toBeNull();
  });

  it("hands the daemon's refusal back to the client as its own text", async () => {
    await makeWorldZip(join(root, "worlds"), "Tulsa");
    await expect(
      makeApi(baseUrl).saveWorldSettings("Tulsa", { gameVersion: "9.9.9" }),
    ).rejects.toThrow(/never be changed/i);
    await expect(
      makeApi(baseUrl).saveWorldSettings("Tulsa", { difficulty: "IMPOSSIBLE" }),
    ).rejects.toThrow(/must be one of/i);
    await expect(
      makeApi(baseUrl).saveWorldSettings("Tulsa", { dayTimeMod: 99 }),
    ).rejects.toThrow(/at most 10/i);
  });
});
