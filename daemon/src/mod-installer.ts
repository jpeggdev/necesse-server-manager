import { copyFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ModLibrary } from "./mod-library.js";
import { workshopEntryUnchanged } from "./mod-updates.js";
import type { ModRegistry } from "./mod-registry.js";
import type { SteamCmd } from "./steamcmd.js";
import type { SteamWorkshop } from "./steam-workshop.js";
import type { DaemonConfig, InstallResult, ModListResponse, WorkshopItem } from "./types.js";

export class ModInstaller {
  constructor(
    private cfg: DaemonConfig,
    private registry: ModRegistry,
    private steam: SteamCmd,
    private library: ModLibrary,
    private workshop: SteamWorkshop,
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

  async install(
    id: string,
    name: string,
    onLine: (line: string) => void,
    workshopUpdatedAt: string | null,
  ): Promise<InstallResult> {
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

    // Into the library, and made the CURRENT jar for its mod, before anything
    // else is recorded.
    //
    // Without this, an install or an `Update All` would be silently reverted:
    // reconcile installs whatever jar the library holds as current, so a new
    // version copied only into the mods folder is deleted at the next start and
    // the old one restored, with no message and no way to notice. That is
    // decision row 1 of docs/mod-sets-design.md - "Update All refreshes the
    // library and every world picks the new version up at its next start" - and
    // this line is what implements it. The library is the source of truth;
    // writing the mods folder alone does not change what a world loads.
    try {
      await this.library.add(join(this.cfg.modsDir, jar), { kind: "workshop", workshopId: id }, jar);
    } catch (e) {
      // A hard failure, not a warning: leaving the jar in the folder but out of
      // the library is exactly the state where the next start quietly undoes
      // this install.
      return {
        id,
        name,
        jar: null,
        ok: false,
        error:
          `${jar} was downloaded but could not be put into the mod library ` +
          `(${(e as Error).message}). The mod library is what a world's mod set is applied from, ` +
          `so this install would have been undone at the next start.`,
      };
    }

    const previous = await this.registry.get(id);
    let replacedJar: string | undefined;
    if (previous && previous.jar !== jar) {
      // Necesse loads every jar in the mods folder, so leaving the old one duplicates the mod.
      // The library keeps its copy either way, so this is never the last one.
      await rm(join(this.cfg.modsDir, previous.jar), { force: true });
      replacedJar = previous.jar;
    }

    await this.registry.upsert({ id, name, jar, lastUpdated: new Date().toISOString(), workshopUpdatedAt });
    return { id, name, jar, ok: true, replacedJar };
  }

  async updateAll(onLine: (line: string) => void): Promise<InstallResult[]> {
    const managed = await this.registry.load();
    const results: InstallResult[] = [];

    // One call for the whole run rather than one per mod.
    let byId = new Map<string, WorkshopItem>();
    try {
      const items = await this.workshop.getDetails(managed.map((m) => m.id));
      byId = new Map(items.map((i) => [i.id, i]));
    } catch (e) {
      // Not fatal and not silent. Every mod becomes unknown, so every mod is
      // reinstalled, which is exactly what this did before the gate existed - a
      // Steam outage costs time and nothing else. Reporting "no updates" here
      // would be the one answer that is actively misleading.
      onLine(`--- Could not reach Steam (${(e as Error).message}). Updating every mod.`);
    }

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    // Sequential by design: ModRegistry does load-modify-write with no locking,
    // so concurrent installs here would clobber each other's writes.
    for (const mod of managed) {
      const entry = byId.get(mod.id);
      const held =
        workshopEntryUnchanged(mod.workshopUpdatedAt, entry) &&
        (await this.library.resolveByWorkshopId(mod.id)) !== undefined;

      if (held) {
        onLine(`--- ${mod.name} (${mod.id}) is unchanged, skipping`);
        results.push({ id: mod.id, name: mod.name, jar: mod.jar, ok: true, skipped: true });
        skipped += 1;
        continue;
      }

      onLine(`--- Updating ${mod.name} (${mod.id})`);
      try {
        const r = await this.install(mod.id, mod.name, onLine, entry?.updatedAt ?? null);
        results.push(r);
        if (r.ok) updated += 1;
        else failed += 1;
      } catch (e) {
        results.push({
          id: mod.id,
          name: mod.name,
          jar: null,
          ok: false,
          error: (e as Error).message,
        });
        failed += 1;
      }
    }

    onLine(`Updated ${updated}, skipped ${skipped}, failed ${failed}.`);
    return results;
  }

  async remove(id: string): Promise<void> {
    const entry = await this.registry.remove(id);
    if (!entry) throw new Error(`Mod ${id} is not managed by this daemon.`);
    await rm(join(this.cfg.modsDir, entry.jar), { force: true });
  }
}
