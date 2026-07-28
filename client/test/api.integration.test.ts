// Cross-package seam test: exercises the real daemon HTTP body parser, not a
// mocked fetch. A test that only asserts which headers fetch() was called
// with cannot catch a Content-Type/body mismatch that Fastify's real parser
// rejects - this test stands up an actual (in-process, ephemeral-port)
// daemon instance against temp directories and a fake spawn, then drives it
// with the real makeApi() over real HTTP. Never point this at the live
// daemon on the LAN - temp dirs + a fake spawn only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../../daemon/src/http.js";
import { ProcessManager } from "../../daemon/src/process-manager.js";
import { ModInstaller } from "../../daemon/src/mod-installer.js";
import { ModRegistry } from "../../daemon/src/mod-registry.js";
import { ModLibrary } from "../../daemon/src/mod-library.js";
import { ModSets } from "../../daemon/src/mod-sets.js";
import { SteamCmd } from "../../daemon/src/steamcmd.js";
import { SteamWorkshop } from "../../daemon/src/steam-workshop.js";
import { DEFAULT_CONFIG } from "../../daemon/src/config.js";
import { makeFakeSpawn } from "../../daemon/test/fixtures/fake-spawn.js";
import { makeWorldZip } from "../../daemon/test/fixtures/world-zip.js";
import { modJarBytes } from "../../daemon/test/fixtures/mod-jar.js";
import { makeApi } from "../src/api";

/** Small enough that the oversize case is a few KB rather than 64MB of payload. */
const UPLOAD_LIMIT = 4096;

let app: ReturnType<typeof buildServer>;
let baseUrl: string;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-client-http-"));
  const modsDir = join(root, "mods");
  const worldsDir = join(root, "worlds");
  await mkdir(modsDir, { recursive: true });
  await mkdir(worldsDir, { recursive: true });
  const cfg = {
    ...DEFAULT_CONFIG,
    modsDir,
    worldsDir,
    stopTimeoutMs: 50,
    // Temp dirs only, per the rule at the top of this file: DEFAULT_CONFIG
    // points the library and the sets at the daemon's own directory in the repo.
    modLibraryDir: join(root, "mod-library"),
    modLibraryFile: join(root, "mod-library.json"),
    modSetsFile: join(root, "mod-sets.json"),
    modUploadMaxBytes: UPLOAD_LIMIT,
  };
  const configFile = join(root, "config.json");
  const spawn = makeFakeSpawn();
  const pm = new ProcessManager(cfg, spawn.spawn);
  const steam = new SteamCmd(cfg, spawn.spawn);
  const library = new ModLibrary(cfg.modLibraryFile, cfg.modLibraryDir);
  const sets = new ModSets(cfg.modSetsFile);
  const installer = new ModInstaller(cfg, new ModRegistry(join(root, "mods.json")), steam, library);
  // Same rule as the fake spawn: this test stands up a real daemon, so its
  // fetch is stubbed to refuse rather than reach Steam. Anything that tries
  // fails loudly instead of quietly making a live call from the test suite.
  const workshop = new SteamWorkshop(cfg, () =>
    Promise.reject(new Error("no network in tests")),
  );
  app = buildServer({ cfg, configFile, pm, installer, library, sets, steam, workshop });
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
 * The mod library over a real socket.
 *
 * `/api/mods/upload` is exactly the shape of defect this file exists for: it is
 * the only route with a non-JSON body, so it depends on a content-type parser
 * that `inject()` never exercises (it sets no content-type) and that a mocked
 * fetch never reaches. A daemon suite alone would pass with the parser
 * unregistered, the header wrong, or the size limit applied in the wrong place.
 */
describe("mod library and reconcile over a real daemon instance", () => {
  /** A real jar: real zip, real mod.info, built the way a workshop mod is. */
  const jar = (id: string, version = "1.0", filler?: string): Promise<Buffer> =>
    modJarBytes({ id, name: id, version, gameVersion: "1.2.0" }, filler === undefined ? {} : { filler });

  it("uploads a jar as a raw body and reads it back out of the library", async () => {
    const api = makeApi(baseUrl);
    const bytes = await jar("someone.realmod", "3.1");

    const res = await api.uploadMod(bytes, "RealMod-3.1.jar");

    expect(res.mod).toMatchObject({
      id: "someone.realmod",
      version: "3.1",
      gameVersion: "1.2.0",
      jar: "RealMod-3.1.jar",
      source: { kind: "local", how: "upload" },
    });
    expect(res.replaced).toBe(false);
    const library = await api.modLibrary();
    expect(library.mods.map((m) => m.id)).toEqual(["someone.realmod"]);
  });

  // The header is what routes the body to the daemon's buffer parser. Getting it
  // wrong is a 415 that no daemon-side test can see.
  it("is refused with the daemon's own message when the jar is not a Necesse mod", async () => {
    const bytes = await modJarBytes({ id: "irrelevant" }, { omitInfo: true });
    await expect(makeApi(baseUrl).uploadMod(bytes, "NotAMod.jar")).rejects.toThrow(
      /no mod\.info at its root/,
    );
  });

  it("cuts an oversize body off at the wire and answers 413, not a truncated success", async () => {
    const api = makeApi(baseUrl);
    await expect(api.uploadMod(Buffer.alloc(UPLOAD_LIMIT + 1, 7), "Huge.jar")).rejects.toMatchObject({
      status: 413,
    });
    // Way past the limit: cut off by the parser rather than held in memory.
    await expect(api.uploadMod(Buffer.alloc(UPLOAD_LIMIT * 4, 7), "Huge.jar")).rejects.toMatchObject({
      status: 413,
    });
    expect((await api.modLibrary()).mods).toEqual([]);
  });

  it("writes a world's set and applies it with a real reconcile", async () => {
    const api = makeApi(baseUrl);
    await api.uploadMod(await jar("a.wanted"), "Wanted-1.0.jar");
    await api.uploadMod(await jar("b.unwanted"), "Unwanted-1.0.jar");

    await api.saveWorldMods("Tulsa", ["a.wanted"]);
    expect((await api.worldMods("Tulsa")).modIds).toEqual(["a.wanted"]);

    const res = await api.reconcileMods("Tulsa");

    expect(res.reconcile.copied).toEqual(["Wanted-1.0.jar"]);
    expect((await readdir(join(root, "mods"))).sort()).toEqual(["Wanted-1.0.jar"]);
  });

  it("hands the daemon's refusal back as its own text for an id the library lacks", async () => {
    await expect(makeApi(baseUrl).saveWorldMods("Tulsa", ["not.here"])).rejects.toThrow(/not\.here/);
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
