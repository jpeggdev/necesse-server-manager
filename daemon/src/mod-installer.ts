import { copyFile, readdir, rm, stat } from "node:fs/promises";
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
    const result = await this.steam.downloadWorkshopItem(id, onLine);
    if (!result.ok) {
      return { id, name, jar: null, ok: false, error: result.output };
    }

    const dir = this.steam.workshopItemDir(id);
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
    // steamcmd's workshop content dir can retain a stale jar left over from a
    // previous version download under a different filename; the most
    // recently written jar is the one this download just produced.
    let jar = jarNames[0];
    if (jarNames.length > 1) {
      const withMtime = await Promise.all(
        jarNames.map(async (f) => ({ f, mtimeMs: (await stat(join(dir, f))).mtimeMs })),
      );
      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
      jar = withMtime[0].f;
    }

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
