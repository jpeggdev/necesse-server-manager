import { dirname, join } from "node:path";
import type { ChildLike, SpawnFn } from "./process-manager.js";
import type { DaemonConfig } from "./types.js";

export interface SteamCmdResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

export class SteamCmd {
  constructor(private cfg: DaemonConfig, private spawnFn: SpawnFn) {}

  private get steamRoot(): string {
    return dirname(this.cfg.steamcmdExe);
  }

  workshopItemDir(id: string): string {
    return join(this.steamRoot, "steamapps", "workshop", "content", String(this.cfg.workshopAppId), id);
  }

  buildWorkshopArgs(id: string): string[] {
    return [
      "+login",
      "anonymous",
      "+workshop_download_item",
      String(this.cfg.workshopAppId),
      id,
      "+quit",
    ];
  }

  buildUpdateArgs(): string[] {
    // force_install_dir must precede login or steamcmd installs to its own root.
    return [
      "+force_install_dir",
      this.cfg.serverRoot,
      "+login",
      "anonymous",
      "+app_update",
      String(this.cfg.serverAppId),
      "validate",
      "+quit",
    ];
  }

  downloadWorkshopItem(id: string, onLine: (line: string) => void): Promise<SteamCmdResult> {
    return this.run(this.buildWorkshopArgs(id), onLine);
  }

  updateApp(onLine: (line: string) => void): Promise<SteamCmdResult> {
    return this.run(this.buildUpdateArgs(), onLine);
  }

  private run(args: string[], onLine: (line: string) => void): Promise<SteamCmdResult> {
    let child: ChildLike;
    try {
      child = this.spawnFn(this.cfg.steamcmdExe, args, { cwd: this.steamRoot });
    } catch (e) {
      return Promise.reject(
        new Error(`Failed to run ${this.cfg.steamcmdExe}: ${(e as Error).message}`),
      );
    }
    return new Promise<SteamCmdResult>((resolve) => {
      const collected: string[] = [];
      let pending = "";
      const ingest = (buf: Buffer | string) => {
        pending += buf.toString();
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.replace(/\r$/, "");
          collected.push(line);
          onLine(line);
        }
      };
      child.stdout.on("data", ingest);
      child.stderr.on("data", ingest);
      child.on("exit", (code) => {
        if (pending.length > 0) {
          collected.push(pending);
          onLine(pending);
        }
        resolve({ ok: code === 0, exitCode: code, output: collected.join("\n") });
      });
    });
  }
}
