import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { buildServer } from "../src/http.js";
import { ProcessManager } from "../src/process-manager.js";
import { ModInstaller } from "../src/mod-installer.js";
import { ModRegistry } from "../src/mod-registry.js";
import { ModLibrary } from "../src/mod-library.js";
import { ModSets } from "../src/mod-sets.js";
import { LaunchOptions } from "../src/launch-options.js";
import { SteamCmd } from "../src/steamcmd.js";
import { SteamWorkshop } from "../src/steam-workshop.js";
import { makeTestConfig } from "./fixtures/test-config.js";
import { makeFakeSpawn } from "./fixtures/fake-spawn.js";
import { makeFakeFetch } from "./fixtures/fake-fetch.js";
import type { DaemonConfig } from "../src/types.js";

let app: ReturnType<typeof buildServer>;
let port: number;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "necesse-ws-auth-"));
  // makeTestConfig, not DEFAULT_CONFIG plus a couple of overrides: the latter
  // builds a config with a modsDir that does not follow from its dataDir,
  // which is a topology loadConfig can no longer produce and configProblems
  // refuses outright.
  const cfg: DaemonConfig = { ...makeTestConfig(root), authToken: "s3cret" };
  const configFile = join(root, "config.json");
  const spawn = makeFakeSpawn();
  const pm = new ProcessManager(cfg, spawn.spawn);
  const steam = new SteamCmd(cfg, spawn.spawn);
  const registry = new ModRegistry(join(root, "mods.json"));
  const library = new ModLibrary(cfg.modLibraryFile, cfg.modLibraryDir);
  const sets = new ModSets(cfg.modSetsFile);
  const net = makeFakeFetch();
  const workshop = new SteamWorkshop(cfg, net.fetch);
  const installer = new ModInstaller(cfg, registry, steam, library, workshop);
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
  // app.inject() cannot perform a real HTTP Upgrade, so this suite is the one
  // place that stands the daemon up on a real socket - see the module doc
  // comment below for why that is load-bearing rather than a nicety.
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("Server has no port address.");
  port = address.port;
});

afterEach(async () => {
  await app.close();
});

type UpgradeResult = { kind: "upgrade" } | { kind: "response"; statusCode: number };

/**
 * Drives a real HTTP Upgrade handshake with node:http directly rather than a
 * WebSocket client library. A `ws`-style client reports "did not connect"
 * identically for a 401 and a refused TCP connection, which collapses exactly
 * the distinction this test exists to pin: the status code the daemon
 * answered the upgrade attempt with, before any protocol switch happened.
 * `ws` is also only a transitive dependency (of @fastify/websocket) rather
 * than one this package declares, so depending on it here would be riding on
 * someone else's dependency tree.
 */
function attemptUpgrade(path: string): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    req.on("upgrade", (_res, socket) => {
      // The daemon accepted the handshake; nothing further is asserted over
      // the socket itself, so it is closed immediately rather than left open.
      socket.destroy();
      resolve({ kind: "upgrade" });
    });
    req.on("response", (res) => {
      res.resume();
      resolve({ kind: "response", statusCode: res.statusCode ?? -1 });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Pins that the root-level `onRequest` auth hook actually guards the `/ws`
 * upgrade, not just the ordinary HTTP routes `http.test.ts` covers with
 * `app.inject()`. The hook and the `/ws` route both live on the same Fastify
 * instance today - a root hook and an encapsulated child plugin - but nothing
 * in the type system enforces that relationship. If a future change moved the
 * hook into an API-only child plugin, every HTTP-only test would stay green
 * while the socket became unauthenticated; only a real upgrade attempt can
 * catch that regression.
 */
describe("WebSocket upgrade authentication", () => {
  it("rejects the upgrade with no token", async () => {
    const result = await attemptUpgrade("/ws");
    expect(result).toEqual({ kind: "response", statusCode: 401 });
  });

  it("rejects the upgrade with the wrong token", async () => {
    const result = await attemptUpgrade("/ws?token=wrong");
    expect(result).toEqual({ kind: "response", statusCode: 401 });
  });

  it("completes the upgrade with the right token as a query parameter", async () => {
    const result = await attemptUpgrade("/ws?token=s3cret");
    expect(result).toEqual({ kind: "upgrade" });
  });
});
