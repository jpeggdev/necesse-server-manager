import { copyFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModRegistry } from "./mod-registry.js";
import type { SteamCmd } from "./steamcmd.js";
import type { DaemonConfig, InstallResult, ModListResponse } from "./types.js";

export class ModInstaller {
  constructor(
    private cfg: DaemonConfig,
    private registry: ModRegistry,
    private steam: SteamCmd,
  ) {}

  async list(): Promise<ModListResponse> {
    const managed = await this.registry.load();
    const known = new Set(managed.map((m) => m.jar.toLowerCase()));
    let files: string[] = [];
    try {
      files = await readdir(this.cfg.modsDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Failed to read mods directory at ${this.cfg.modsDir}: ${(e as Error).message}`);
      }
    }
    const untracked = files
      .filter((f) => f.toLowerCase().endsWith(".jar") && !known.has(f.toLowerCase()))
      .map((jar) => ({ jar }));
    return { managed, untracked };
  }

  async install(id: string, name: string, onLine: (line: string) => void): Promise<InstallResult> {
    const dir = this.steam.workshopItemDir(id);
    // Clear the item's download dir first so a stale jar from a previous version
    // (under a different filename) can never be mistaken for this download's
    // output. This forfeits steamcmd's incremental re-download for this item,
    // which is the right trade: an update is precisely when we want a clean
    // fetch, and correctness of which jar gets installed dominates download time.
    await rm(dir, { recursive: true, force: true });

    const result = await this.steam.downloadWorkshopItem(id, onLine);
    if (!result.ok) {
      return { id, name, jar: null, ok: false, error: result.output };
    }

    let dirFiles: string[] = [];
    try {
      dirFiles = await readdir(dir);
    } catch (e) {
      // A missing download dir just means "no jar was produced" (handled below);
      // anything else (e.g. a permissions error, or the path colliding with a file)
      // is a real failure and must not be reported as the same generic no-jar case.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        return { id, name, jar: null, ok: false, error: `Cannot read ${dir}: ${(e as Error).message}` };
      }
    }
    const jarNames = dirFiles.filter((f) => f.toLowerCase().endsWith(".jar"));
    if (jarNames.length === 0) {
      return {
        id,
        name,
        jar: null,
        ok: false,
        error: `steamcmd reported success but no .jar was found in ${dir}`,
      };
    }
    if (jarNames.length > 1) {
      // The item dir was cleared before this download, so more than one jar here
      // means the workshop item itself shipped multiple jars. That's rare enough,
      // and choosing wrong is bad enough, that this must fail loudly rather than guess.
      return {
        id,
        name,
        jar: null,
        ok: false,
        error: `steamcmd produced more than one .jar in ${dir}: ${jarNames.join(", ")}`,
      };
    }
    const jar = jarNames[0];

    try {
      await copyFile(join(dir, jar), join(this.cfg.modsDir, jar));
    } catch (e) {
      return { id, name, jar: null, ok: false, error: `Failed to copy ${jar}: ${(e as Error).message}` };
    }

    const previous = await this.registry.get(id);
    let replacedJar: string | undefined;
    if (previous && previous.jar !== jar) {
      // Necesse loads every jar in the mods folder, so leaving the old one duplicates the mod.
      await rm(join(this.cfg.modsDir, previous.jar), { force: true });
      replacedJar = previous.jar;
    }

    await this.registry.upsert({ id, name, jar, lastUpdated: new Date().toISOString() });
    return { id, name, jar, ok: true, replacedJar };
  }

  async updateAll(onLine: (line: string) => void): Promise<InstallResult[]> {
    const managed = await this.registry.load();
    const results: InstallResult[] = [];
    // Sequential by design: ModRegistry does load-modify-write with no locking,
    // so concurrent installs here would clobber each other's writes.
    for (const mod of managed) {
      onLine(`--- Updating ${mod.name} (${mod.id})`);
      try {
        results.push(await this.install(mod.id, mod.name, onLine));
      } catch (e) {
        results.push({ id: mod.id, name: mod.name, jar: null, ok: false, error: (e as Error).message });
      }
    }
    return results;
  }

  async remove(id: string): Promise<void> {
    const entry = await this.registry.remove(id);
    if (!entry) throw new Error(`Mod ${id} is not managed by this daemon.`);
    await rm(join(this.cfg.modsDir, entry.jar), { force: true });
  }
}
