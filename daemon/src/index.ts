import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBootConfig } from "./config.js";
import { buildServer } from "./http.js";
import { LaunchOptions } from "./launch-options.js";
import { runOwnerMigration } from "./launch-options-migration.js";
import { ModInstaller } from "./mod-installer.js";
import { ModLibrary } from "./mod-library.js";
import { ModRegistry } from "./mod-registry.js";
import { ModSets } from "./mod-sets.js";
import { migrateModSets } from "./mod-migration.js";
import { resolveLegacyState } from "./migrate-state.js";
import { ProcessManager, type SpawnFn } from "./process-manager.js";
import { BOOT_REFUSAL_FILE, stateDir, stateFile } from "./state-dir.js";
import { SteamCmd } from "./steamcmd.js";
import { SteamWorkshop } from "./steam-workshop.js";
import { findOrphanServer, listJavaProcesses } from "./orphan.js";

const here = dirname(fileURLToPath(import.meta.url));
// Where the code lives. Not where state lives - see state-dir.ts.
const installDir = join(here, "..");
const dir = stateDir();
const refusalLog = join(dir, BOOT_REFUSAL_FILE);

/**
 * Refuses the boot loudly enough to be found afterwards.
 *
 * The console half is useless in the arrangement this daemon is actually
 * deployed in: it runs as a Scheduled Task, whose stdout is discarded, so an
 * operator watching 04-restart-daemon.ps1 sees only "the task did not reach
 * Running" and none of the text that says what to fix. The file is the durable
 * half. A failure to write it is reported and then ignored - the refusal still
 * stands, and a daemon that started anyway because it could not write a log
 * would be strictly worse.
 */
async function recordRefusal(message: string): Promise<void> {
  console.error(message);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(refusalLog, `${new Date().toISOString()}\n\n${message}\n`, "utf8");
    console.error(`\nThis message was also written to ${refusalLog}.`);
  } catch (e) {
    console.error(`Could not write ${refusalLog}: ${(e as Error).message}`);
  }
}

// Before the config is even read: an install whose state is still beside dist/
// would otherwise boot against an empty state directory, silently presenting
// itself as a fresh install and leaving the real mod library behind.
const legacyRefusal = await resolveLegacyState(installDir, dir);
if (legacyRefusal !== null) {
  await recordRefusal(legacyRefusal);
  process.exit(1);
}

const boot = await resolveBootConfig(dir);
if (!boot.ok) {
  await recordRefusal(boot.message);
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

const launchOptions = new LaunchOptions(stateFile("launch-options.json"));

// Guarded the same way migrateModSets is below: a corrupt config.json or
// launch-options.json must not take the whole daemon down - a daemon that
// cannot read its launch options can still list worlds, manage mods and
// report status. POST /api/server/start (http.ts) is what refuses loudly of
// its own accord if launch options are genuinely still broken at that point -
// it does not fall back to starting with zero options.
const ownerMigration = await runOwnerMigration(configFile, launchOptions);
if (ownerMigration.message !== null) {
  if (ownerMigration.failed) console.error(ownerMigration.message);
  else console.warn(ownerMigration.message);
  // Not just console: stdout is discarded under the Scheduled Task this
  // daemon actually runs as, so the "this is not a silent change" guarantee
  // the migration exists to make - and the report of it failing to make that
  // guarantee - only reach an operator via configWarnings, which GET
  // /api/config already publishes.
  configWarnings.push(ownerMigration.message);
}

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
  launchOptions,
});
await app.listen({ host: "0.0.0.0", port: cfg.port });
// A refusal log that outlived the problem it described would send the next
// operator to fix something that is already fixed.
await rm(refusalLog, { force: true });
console.log(
  `necesse-daemon listening on 0.0.0.0:${cfg.port} ` +
    // .trim(), matching tokenMatches and publicConfig exactly. Without it a
    // whitespace-only token banners "token required" while the daemon in fact
    // accepts every request - the one wrong answer that reads as reassurance.
    `(${cfg.authToken.trim().length > 0 ? "token required" : "NO ACCESS TOKEN - anyone on this network can control the server"})`,
);
