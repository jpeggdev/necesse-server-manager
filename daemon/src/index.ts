import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { buildServer } from "./http.js";
import { ModInstaller } from "./mod-installer.js";
import { ModRegistry } from "./mod-registry.js";
import { ProcessManager, type SpawnFn } from "./process-manager.js";
import { SteamCmd } from "./steamcmd.js";
import { SteamWorkshop } from "./steam-workshop.js";
import { findOrphanServer, listJavaProcesses } from "./orphan.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..");
const configFile = join(dataDir, "config.json");
const modsFile = join(dataDir, "mods.json");

const spawnFn: SpawnFn = (cmd, args, opts) =>
  // `as const` fixes stdio as the literal 3-tuple ("pipe","pipe","pipe") rather
  // than widening to string[], which is what lets TS's spawn overload pick
  // ChildProcessWithoutNullStreams (non-null stdin/stdout/stderr) -- the
  // exact shape ChildLike requires. No cast needed once the overload matches.
  nodeSpawn(cmd, args, {
    cwd: opts.cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"] as const,
  });

const cfg = await loadConfig(configFile);
const pm = new ProcessManager(cfg, spawnFn);
const steam = new SteamCmd(cfg, spawnFn);
const installer = new ModInstaller(cfg, new ModRegistry(modsFile), steam);
// Node's global fetch, wrapped so what SteamWorkshop sees is its own narrow
// FetchFn rather than the full DOM signature. This is the only place in the
// daemon that reaches the network directly.
const workshop = new SteamWorkshop(cfg, (url, init) => fetch(url, init));

const orphan = await findOrphanServer(listJavaProcesses, cfg.serverJar);
if (orphan) {
  pm.markUnmanaged(orphan.pid);
  console.warn(
    `A Necesse server (pid ${orphan.pid}) is already running and was not started by this daemon. ` +
      `It cannot be stopped gracefully from here.`,
  );
}

const app = buildServer({ cfg, configFile, pm, installer, steam, workshop });
await app.listen({ host: "0.0.0.0", port: cfg.port });
console.log(`necesse-daemon listening on 0.0.0.0:${cfg.port}`);
