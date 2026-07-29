import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBootConfig } from "./config.js";
import { buildServer } from "./http.js";
import { ModInstaller } from "./mod-installer.js";
import { ModLibrary } from "./mod-library.js";
import { ModRegistry } from "./mod-registry.js";
import { ModSets } from "./mod-sets.js";
import { migrateModSets } from "./mod-migration.js";
import { resolveLegacyState } from "./migrate-state.js";
import { ProcessManager, type SpawnFn } from "./process-manager.js";
import { stateDir } from "./state-dir.js";
import { SteamCmd } from "./steamcmd.js";
import { SteamWorkshop } from "./steam-workshop.js";
import { findOrphanServer, listJavaProcesses } from "./orphan.js";

const here = dirname(fileURLToPath(import.meta.url));
// Where the code lives. Not where state lives - see state-dir.ts.
const installDir = join(here, "..");
const dir = stateDir();

// Before the config is even read: an install whose state is still beside dist/
// would otherwise boot against an empty state directory, silently presenting
// itself as a fresh install and leaving the real mod library behind.
const legacyRefusal = await resolveLegacyState(installDir, dir);
if (legacyRefusal !== null) {
  console.error(legacyRefusal);
  process.exit(1);
}

const boot = await resolveBootConfig(dir);
if (!boot.ok) {
  console.error(boot.message);
  process.exit(1);
}
const { cfg, configFile, configWarnings } = boot;
for (const w of configWarnings) console.warn(`Configuration warning: ${w}`);

const modsFile = join(dir, "mods.json");

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

const pm = new ProcessManager(cfg, spawnFn);
const steam = new SteamCmd(cfg, spawnFn);
const registry = new ModRegistry(modsFile);
const library = new ModLibrary(cfg.modLibraryFile, cfg.modLibraryDir);
const sets = new ModSets(cfg.modSetsFile);
// The installer writes every download into the library as that mod's current
// jar, because the library - not the mods folder - is what reconcile applies a
// world's set from.
const installer = new ModInstaller(cfg, registry, steam, library);
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

// Seeds the library and the per-world sets from whatever this box already has,
// once, before anything can be started. Purely additive - it never writes to the
// mods folder - so it is safe even with the orphan above still up, and it is
// idempotent, so it costs a directory scan on every subsequent boot and nothing
// else. A failure here must not take the daemon down with it: the API is still
// worth having, and every start refuses on its own if a set cannot be applied.
try {
  await migrateModSets({
    modsDir: cfg.modsDir,
    worldsDir: cfg.worldsDir,
    library,
    sets,
    registry,
    workshopItemDir: (id) => steam.workshopItemDir(id),
  });
} catch (e) {
  console.error(`Mod library migration failed: ${(e as Error).message}`);
}

const app = buildServer({
  cfg,
  configFile,
  configWarnings,
  pm,
  installer,
  library,
  sets,
  steam,
  workshop,
});
await app.listen({ host: "0.0.0.0", port: cfg.port });
console.log(
  `necesse-daemon listening on 0.0.0.0:${cfg.port} ` +
    `(${cfg.authToken.length > 0 ? "token required" : "NO ACCESS TOKEN - anyone on this network can control the server"})`,
);
