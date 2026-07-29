import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configProblems, fatalProblems, loadConfig, readStoredConfig } from "./config.js";
import { buildServer } from "./http.js";
import { ModInstaller } from "./mod-installer.js";
import { ModLibrary } from "./mod-library.js";
import { ModRegistry } from "./mod-registry.js";
import { ModSets } from "./mod-sets.js";
import { migrateModSets } from "./mod-migration.js";
import { ProcessManager, type SpawnFn } from "./process-manager.js";
import { SteamCmd } from "./steamcmd.js";
import { SteamWorkshop } from "./steam-workshop.js";
import { findOrphanServer, listJavaProcesses } from "./orphan.js";

const here = dirname(fileURLToPath(import.meta.url));
// The daemon's own directory, holding config.json and mods.json. Not to be
// confused with cfg.dataDir, which is the *game's* data directory.
const daemonDir = join(here, "..");
const configFile = join(daemonDir, "config.json");
const modsFile = join(daemonDir, "mods.json");

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

// Before anything reads a folder or spawns anything. A daemon that reconciles
// one mods folder while the game loads another is worse than a daemon that did
// not start: the wrong-mod-set launch it produces looks entirely successful.
// Stub pending Task 5, which wires configWarnings (the non-fatal problems)
// into the HTTP layer instead of discarding them here.
const fatal = fatalProblems(await configProblems(cfg, await readStoredConfig(configFile)));
if (fatal.length > 0) {
  throw new Error(`${fatal.map((p) => p.message).join(" ")} (config: ${configFile})`);
}

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

const app = buildServer({ cfg, configFile, pm, installer, library, sets, steam, workshop });
await app.listen({ host: "0.0.0.0", port: cfg.port });
console.log(`necesse-daemon listening on 0.0.0.0:${cfg.port}`);
