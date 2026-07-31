// Cross-package seam test: exercises the real daemon HTTP body parser, not a
// mocked fetch. A test that only asserts which headers fetch() was called
// with cannot catch a Content-Type/body mismatch that Fastify's real parser
// rejects - this test stands up an actual (in-process, ephemeral-port)
// daemon instance against temp directories and a fake spawn, then drives it
// with the real makeApi() over real HTTP. Never point this at the live
// daemon on the LAN - temp dirs + a fake spawn only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { buildServer } from "../../daemon/src/http.js";
import { ProcessManager } from "../../daemon/src/process-manager.js";
import { ModInstaller } from "../../daemon/src/mod-installer.js";
import { ModRegistry } from "../../daemon/src/mod-registry.js";
import { ModLibrary } from "../../daemon/src/mod-library.js";
import { ModSets } from "../../daemon/src/mod-sets.js";
import { LaunchOptions } from "../../daemon/src/launch-options.js";
import { SteamCmd } from "../../daemon/src/steamcmd.js";
import { SteamWorkshop } from "../../daemon/src/steam-workshop.js";
import { makeTestConfig } from "../../daemon/test/fixtures/test-config.js";
import { makeFakeSpawn } from "../../daemon/test/fixtures/fake-spawn.js";
import { makeWorldZip } from "../../daemon/test/fixtures/world-zip.js";
import { modJarBytes } from "../../daemon/test/fixtures/mod-jar.js";
import { makeApi } from "../src/api";
import { wsUrl, type Connection } from "../src/settings";

/** Small enough that the oversize case is a few KB rather than 64MB of payload. */
const UPLOAD_LIMIT = 4096;

/** Every call in this file authenticates with this token; the rejection cases override it. */
const TOKEN = "integration-test-token";

const UPGRADE_TIMEOUT_MS = 2000;

/**
 * The HTTP status the daemon answers a WebSocket upgrade with.
 *
 * Driven at the http layer rather than through a WebSocket client because the
 * assertion is about the handshake itself: a client library reports "it did not
 * connect" identically for a 401 and a refused connection, and telling those
 * apart is the whole point of this test.
 */
const upgradeStatus = (url: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({
      host: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`No upgrade response from ${url} within ${UPGRADE_TIMEOUT_MS}ms`));
    }, UPGRADE_TIMEOUT_MS);
    req.on("upgrade", (res, socket) => {
      clearTimeout(timer);
      socket.destroy();
      // res.statusCode is only optional in the type, not in practice for a real
      // upgrade response - reading it straight through, with no fallback, means
      // a daemon that somehow omitted it fails this assertion instead of the
      // test quietly reporting 101 regardless of what actually happened.
      const status = res.statusCode;
      if (status === undefined) {
        reject(new Error("upgrade response carried no status code"));
        return;
      }
      resolve(status);
    });
    req.on("response", (res) => {
      clearTimeout(timer);
      res.resume();
      res.socket?.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });

/** The Connection wsUrl() needs, built from the ephemeral port app.listen() chose this run. */
const wsConnection = (token: string): Connection => {
  const u = new URL(baseUrl);
  return { host: u.hostname, port: Number(u.port), token };
};

let app: ReturnType<typeof buildServer>;
let baseUrl: string;
let root: string;
/** cfg.modsDir/cfg.worldsDir, derived from dataDir - captured so tests can reach into them by their real location rather than the pre-Task-2 literal "root/mods". */
let modsDir: string;
let worldsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-client-http-"));
  // modsDir/worldsDir are derived from dataDir and makeTestConfig already
  // creates both on disk - a config where they disagree with dataDir now
  // refuses to boot, so overriding them here would drive this seam test
  // through a topology loadConfig can no longer produce.
  const cfg = {
    ...makeTestConfig(root),
    stopTimeoutMs: 50,
    // Temp dirs only, per the rule at the top of this file: makeTestConfig
    // points the library and the sets at its own temp root, not the repo.
    modLibraryDir: join(root, "mod-library"),
    modLibraryFile: join(root, "mod-library.json"),
    modSetsFile: join(root, "mod-sets.json"),
    modUploadMaxBytes: UPLOAD_LIMIT,
    authToken: TOKEN,
  };
  modsDir = cfg.modsDir;
  worldsDir = cfg.worldsDir;
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
  const launchOptions = new LaunchOptions(join(root, "launch-options.json"));
  app = buildServer({
    cfg,
    configFile,
    configWarnings: [],
    pm,
    installer,
    library,
    sets,
    steam,
    workshop,
    launchOptions,
  });
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
    await expect(makeApi(baseUrl, TOKEN).stop()).rejects.toThrow(/not running/i);
  });

  it("kill() reaches the route handler instead of 400ing on an empty JSON body", async () => {
    await expect(makeApi(baseUrl, TOKEN).kill()).rejects.toThrow(/no managed server/i);
  });

  it("updateServer() reaches the route handler instead of 400ing on an empty JSON body", async () => {
    const res = await makeApi(baseUrl, TOKEN).updateServer();
    expect(res.ok).toBe(true);
    expect(typeof res.taskId).toBe("string");
  });

  it("updateAllMods() reaches the route handler instead of 400ing on an empty JSON body", async () => {
    const res = await makeApi(baseUrl, TOKEN).updateAllMods();
    expect(res.ok).toBe(true);
    expect(typeof res.taskId).toBe("string");
  });

  it("removeMod() (bodyless DELETE) reaches the route handler instead of 400ing", async () => {
    // Same root cause, same request() codepath, different verb: confirm the
    // fix isn't accidentally POST-specific.
    await expect(makeApi(baseUrl, TOKEN).removeMod("999")).rejects.toThrow(/not managed/i);
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
    const api = makeApi(baseUrl, TOKEN);
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
    await expect(makeApi(baseUrl, TOKEN).uploadMod(bytes, "NotAMod.jar")).rejects.toThrow(
      /no mod\.info at its root/,
    );
  });

  it("cuts an oversize body off at the wire and answers 413, not a truncated success", async () => {
    const api = makeApi(baseUrl, TOKEN);
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
    const api = makeApi(baseUrl, TOKEN);
    await api.uploadMod(await jar("a.wanted"), "Wanted-1.0.jar");
    await api.uploadMod(await jar("b.unwanted"), "Unwanted-1.0.jar");

    await api.saveWorldMods("Tulsa", ["a.wanted"]);
    expect((await api.worldMods("Tulsa")).modIds).toEqual(["a.wanted"]);

    const res = await api.reconcileMods("Tulsa");

    expect(res.reconcile.copied).toEqual(["Wanted-1.0.jar"]);
    expect((await readdir(modsDir)).sort()).toEqual(["Wanted-1.0.jar"]);
  });

  it("hands the daemon's refusal back as its own text for an id the library lacks", async () => {
    await expect(makeApi(baseUrl, TOKEN).saveWorldMods("Tulsa", ["not.here"])).rejects.toThrow(/not\.here/);
  });

  /*
   * The distinction the panel's wording rests on, over the wire. A world nobody
   * has chosen a set for reports what starting it would load - and would then
   * save - while a world deliberately set to load nothing reports an empty list.
   * The two payloads are the same shape and differ only in `configured`, so a
   * client that dropped that flag would show "no mods" for a world about to
   * load eight.
   */
  it("tells a world with no set apart from a world whose set is empty", async () => {
    const api = makeApi(baseUrl, TOKEN);
    await writeFile(join(modsDir, "Wanted-1.0.jar"), await jar("a.wanted"));

    expect(await api.worldMods("Fresh")).toMatchObject({
      configured: false,
      modIds: ["a.wanted"],
    });

    expect(await api.saveWorldMods("Fresh", [])).toMatchObject({ configured: true, modIds: [] });
    expect(await api.worldMods("Fresh")).toMatchObject({ configured: true, modIds: [] });
    // Reading an unconfigured world's set must not quietly write one: the world
    // above still had none until the save, or opening the panel would decide a
    // set for every world it looked at.
    expect(await api.worldMods("Untouched")).toMatchObject({ configured: false });
  });

  /*
   * Decision row 1 of docs/mod-sets-design.md, end to end: a set names mod
   * identities, not jars, so a new version of a mod is picked up with no edit to
   * any world. Uploading is the version of that this client can drive without
   * Steam.
   */
  it("carries a set onto a newer jar of the same mod, with no edit to the set", async () => {
    const api = makeApi(baseUrl, TOKEN);
    await api.uploadMod(await jar("a.mod", "1.0"), "Mod-1.0.jar");
    await api.saveWorldMods("Tulsa", ["a.mod"]);
    await api.reconcileMods("Tulsa");
    expect(await readdir(modsDir)).toEqual(["Mod-1.0.jar"]);

    const second = await api.uploadMod(await jar("a.mod", "2.0"), "Mod-2.0.jar");

    expect(second.replaced).toBe(true);
    expect((await api.worldMods("Tulsa")).modIds).toEqual(["a.mod"]);
    const applied = await api.reconcileMods("Tulsa");
    expect(applied.reconcile.copied).toEqual(["Mod-2.0.jar"]);
    expect(applied.reconcile.removed).toEqual(["Mod-1.0.jar"]);
    expect(await readdir(modsDir)).toEqual(["Mod-2.0.jar"]);
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
    await makeWorldZip(worldsDir, "Tulsa");
    const res = await makeApi(baseUrl, TOKEN).worldSettings("Tulsa");

    const difficulty = res.fields.find((f) => f.key === "difficulty");
    // The option set the form renders comes from here, not from the client.
    expect(difficulty?.options).toContain("BRUTAL");
    expect(res.fields.find((f) => f.key === "gameVersion")?.editable).toBe(false);
    const modKey = res.fields.find((f) => f.key === "rpgskillsWorldStackLevel");
    expect(modKey?.type).toBeNull();
    expect(modKey?.editable).toBe(false);
  });

  it("applies a partial change and reports where the backup went", async () => {
    await makeWorldZip(worldsDir, "Tulsa");
    const api = makeApi(baseUrl, TOKEN);
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
    await makeWorldZip(worldsDir, "Tulsa");
    const res = await makeApi(baseUrl, TOKEN).saveWorldSettings("Tulsa", { allowCheats: false });
    expect(res.changed).toEqual([]);
    expect(res.backup).toBeNull();
  });

  it("hands the daemon's refusal back to the client as its own text", async () => {
    await makeWorldZip(worldsDir, "Tulsa");
    await expect(
      makeApi(baseUrl, TOKEN).saveWorldSettings("Tulsa", { gameVersion: "9.9.9" }),
    ).rejects.toThrow(/never be changed/i);
    await expect(
      makeApi(baseUrl, TOKEN).saveWorldSettings("Tulsa", { difficulty: "IMPOSSIBLE" }),
    ).rejects.toThrow(/must be one of/i);
    await expect(
      makeApi(baseUrl, TOKEN).saveWorldSettings("Tulsa", { dayTimeMod: 99 }),
    ).rejects.toThrow(/at most 10/i);
  });
});

describe("access token over the real transport", () => {
  it("rejects a GET with no token", async () => {
    await expect(makeApi(baseUrl, "").status()).rejects.toThrow(/token/i);
  });

  it("rejects a GET with the wrong token", async () => {
    await expect(makeApi(baseUrl, "wrong").status()).rejects.toThrow(/token/i);
  });

  it("rejects a bodyless POST with the wrong token", async () => {
    await expect(makeApi(baseUrl, "wrong").stop()).rejects.toThrow(/token/i);
  });

  it("surfaces the rejection as a 401 the client can branch on", async () => {
    await expect(makeApi(baseUrl, "wrong").status()).rejects.toMatchObject({ status: 401 });
  });

  it("rejects the raw-body jar upload with the wrong token", async () => {
    // uploadMod builds its own fetch rather than going through request(), so
    // it is the one call that can be missing the header while every other
    // action works. Asserted here, over a real socket, for that reason.
    await expect(
      makeApi(baseUrl, "wrong").uploadMod(await modJarBytes({ id: "x.y", name: "X" }), "x.jar"),
    ).rejects.toThrow(/token/i);
  });

  it("accepts the jar upload with the right token", async () => {
    const r = await makeApi(baseUrl, TOKEN).uploadMod(
      await modJarBytes({ id: "x.y", name: "X" }),
      "x.jar",
    );
    expect(r.ok).toBe(true);
  });

  it("rejects the websocket upgrade without a token", async () => {
    // Built by the app's own wsUrl(), not a hand-rolled string: a regression that
    // stopped the client attaching ?token= would otherwise go unnoticed here.
    const status = await upgradeStatus(wsUrl(wsConnection("")));
    expect(status).toBe(401);
  });

  it("accepts the websocket upgrade with the token on the query string", async () => {
    const status = await upgradeStatus(wsUrl(wsConnection(TOKEN)));
    expect(status).toBe(101);
  });
});

/**
 * A raw PUT with no body at all - not through `makeApi`, because
 * `saveLaunchOptions` always JSON.stringifies a payload and so can never
 * produce this shape itself. `addContentTypeParser` in http.ts treats an
 * empty JSON body as absent for bodyless POSTs (stop/kill/update-all), and
 * the daemon suite proves that generic behaviour via `inject()` - but nothing
 * before this file has sent a real bodyless PUT over a real socket, and PUT
 * is the one verb the launch-options routes accept. A client, curl script, or
 * second GUI that sets the JSON content-type on a no-op save must not 400.
 */
const rawPut = (url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      { host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: "PUT", headers },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });

/*
 * Launch options across the real seam.
 *
 * Routed here out of the Task 5/6 reviews as things their own tests
 * structurally could not see: `null` vs `""` surviving the wire distinctly,
 * the PUT content-type over a real socket, `encodeURIComponent(world)`
 * round-tripping through the daemon's echoed `world`, verbatim 400 text over
 * a real socket, and PUT-echo agreeing with a fresh GET.
 */
describe("launch options across the real seam", () => {
  it("stores a default and reads it back as effective for a world", async () => {
    const api = makeApi(baseUrl, TOKEN);
    await api.saveLaunchOptions(null, { owner: "Jeff" });
    const res = await api.launchOptions("Tulsa");
    expect(res.effective.owner).toBe("Jeff");
    expect(res.overrides).toEqual({});
  });

  it("lets a world override a default", async () => {
    const api = makeApi(baseUrl, TOKEN);
    await api.saveLaunchOptions(null, { owner: "Jeff" });
    await api.saveLaunchOptions("Tulsa", { owner: "Eli" });
    const res = await api.launchOptions("Tulsa");
    expect(res.effective.owner).toBe("Eli");
    expect(res.defaults.owner).toBe("Jeff");
  });

  it("clears an override with an explicit null", async () => {
    const api = makeApi(baseUrl, TOKEN);
    await api.saveLaunchOptions(null, { slots: 5 });
    await api.saveLaunchOptions("Tulsa", { slots: 20 });
    await api.saveLaunchOptions("Tulsa", { slots: null });
    expect((await api.launchOptions("Tulsa")).effective).toEqual({ slots: 5 });
  });

  // The most important item on the routed list: the client sends `null` to
  // clear an option and "" to store an empty flag value, and the two must
  // never collapse into each other on the way through JSON, Fastify
  // validation, and `applyChanges`. A falsy-check regression (`if (!value)`
  // instead of `if (value === null)`) would delete "" as if it were a clear.
  it("keeps an explicit empty string distinct from a clearing null", async () => {
    const api = makeApi(baseUrl, TOKEN);
    await api.saveLaunchOptions(null, { owner: "Jeff" });

    const emptied = await api.saveLaunchOptions("Tulsa", { owner: "" });
    expect(emptied.overrides).toEqual({ owner: "" });
    expect(emptied.effective.owner).toBe("");

    // The PUT echo alone only proves the daemon reflected "" back, not that
    // it was stored - a load() that dropped empty strings would still pass
    // the two assertions above. Re-read with a fresh GET to prove it landed.
    const reread = await api.launchOptions("Tulsa");
    expect(reread.overrides).toEqual({ owner: "" });
    expect(reread.effective.owner).toBe("");

    const cleared = await api.saveLaunchOptions("Tulsa", { owner: null });
    expect(cleared.overrides).toEqual({});
    expect(cleared.effective.owner).toBe("Jeff");
  });

  /*
   * `null` clears, and every other value is a stored override - including the
   * falsy ones. `""` was already covered above; `false` and `0` were not, and
   * a falsy-check regression in `applyChanges` collapses all three into a
   * clear. Each asserts the stored override AND the different answer a clear
   * would give, over a real socket, so neither half passes on its own.
   */
  it("keeps a false boolean distinct from a clearing null", async () => {
    const api = makeApi(baseUrl, TOKEN);
    await api.saveLaunchOptions(null, { pausewhenempty: true });

    const off = await api.saveLaunchOptions("Tulsa", { pausewhenempty: false });
    expect(off.overrides).toEqual({ pausewhenempty: false });
    expect(off.effective.pausewhenempty).toBe(false);

    // A PUT echo alone would still pass if the daemon reflected the payload
    // back without storing it. Re-read to prove it landed.
    const reread = await api.launchOptions("Tulsa");
    expect(reread.overrides).toEqual({ pausewhenempty: false });
    expect(reread.effective.pausewhenempty).toBe(false);

    const cleared = await api.saveLaunchOptions("Tulsa", { pausewhenempty: null });
    expect(cleared.overrides).toEqual({});
    expect(cleared.effective.pausewhenempty).toBe(true);
  });

  it("keeps a 0 distinct from a clearing null", async () => {
    // 0 means "dropped items last forever" for itemslife: a real value, and
    // the opposite of the 30 it would fall back to if it were treated as a
    // clear.
    const api = makeApi(baseUrl, TOKEN);
    await api.saveLaunchOptions(null, { itemslife: 30 });

    const zero = await api.saveLaunchOptions("Tulsa", { itemslife: 0 });
    expect(zero.overrides).toEqual({ itemslife: 0 });
    expect(zero.effective.itemslife).toBe(0);

    const reread = await api.launchOptions("Tulsa");
    expect(reread.overrides).toEqual({ itemslife: 0 });
    expect(reread.effective.itemslife).toBe(0);

    const cleared = await api.saveLaunchOptions("Tulsa", { itemslife: null });
    expect(cleared.overrides).toEqual({});
    expect(cleared.effective.itemslife).toBe(30);
  });

  // The game parses its whole command line as one joined string, so a text
  // value with a word starting with `-` empties the option it was set on and
  // injects a flag that is not on offer here. Pinned across the real socket
  // because the client is what sends free text.
  it("refuses a text value the game's parser would read as another flag", async () => {
    const api = makeApi(baseUrl, TOKEN);
    await expect(api.saveLaunchOptions("Tulsa", { owner: "-settings C:/evil.cfg" })).rejects.toThrow(
      /read back as another flag/i,
    );
    expect((await api.launchOptions("Tulsa")).overrides).toEqual({});
  });

  it("refuses an out-of-range value with the daemon's own message", async () => {
    await expect(makeApi(baseUrl, TOKEN).saveLaunchOptions("Tulsa", { slots: 999 })).rejects.toThrow(
      /1 and 250/,
    );
  });

  it("refuses a daemon-owned argument over the wire", async () => {
    await expect(
      makeApi(baseUrl, TOKEN).saveLaunchOptions("Tulsa", { datadir: "C:\\evil" } as never),
    ).rejects.toThrow(/not a known/i);
  });

  it("serves a field list with the daemon's real fields and no daemon-owned argument", async () => {
    const names = (await makeApi(baseUrl, TOKEN).launchOptions()).fields.map((f) => f.name);
    // Self-supporting, matching daemon/test/http.test.ts:2070: without this an
    // empty field list would trivially "never offer" a forbidden name too.
    expect(names).toEqual(expect.arrayContaining(["owner", "slots", "port"]));
    for (const forbidden of ["datadir", "world", "nogui"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  // The client builds the URL with encodeURIComponent(world); the daemon
  // decodes the :world param and echoes it back as `world` in the response;
  // LaunchOptionsDialog compares that echo against the world it asked about
  // to know its read has landed. A plain name like "Tulsa" never exercises
  // that encode/decode step - this name needs it (space, &, %, and a non-ASCII
  // character all force real percent-encoding).
  it("round-trips a world name that needs percent-encoding", async () => {
    const world = "Owner's World & Café 100%";
    const api = makeApi(baseUrl, TOKEN);

    const put = await api.saveLaunchOptions(world, { owner: "Jeff" });
    expect(put.world).toBe(world);

    const fresh = await api.launchOptions(world);
    expect(fresh.world).toBe(world);
    expect(fresh.effective.owner).toBe("Jeff");
  });

  // What a PUT hands back must be exactly what a subsequent GET reports, or
  // the dialog shows one thing right after saving and a different thing on
  // reload.
  it("agrees with a fresh GET after a PUT", async () => {
    const api = makeApi(baseUrl, TOKEN);
    const put = await api.saveLaunchOptions("Tulsa", { owner: "Jeff", slots: 10 });
    const fresh = await api.launchOptions("Tulsa");
    expect(fresh).toEqual(put);
  });

  it("accepts an empty-body PUT the way it accepts an empty-body POST, on both routes", async () => {
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

    const defaultsRes = await rawPut(`${baseUrl}/api/launch-options`, headers);
    expect(defaultsRes.status).toBe(200);
    const defaultsBody = JSON.parse(defaultsRes.body) as { ok: boolean; world: string | null };
    expect(defaultsBody.ok).toBe(true);
    expect(defaultsBody.world).toBeNull();

    // The defaults route and the world route parse the body independently -
    // `req.body ?? {}` appears once per handler in http.ts, so a fix (or a
    // regression) to one route says nothing about the other.
    const worldRes = await rawPut(`${baseUrl}/api/worlds/Tulsa/launch-options`, headers);
    expect(worldRes.status).toBe(200);
    const worldBody = JSON.parse(worldRes.body) as { ok: boolean; world: string | null };
    expect(worldBody.ok).toBe(true);
    expect(worldBody.world).toBe("Tulsa");
  });
});
