import { readFile, writeFile } from "node:fs/promises";
import type { ModEntry } from "./types.js";

export class ModRegistry {
  constructor(private file: string) {}

  async load(): Promise<ModEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Failed to read mod registry at ${this.file}: ${(e as Error).message}`);
      }
      return [];
    }
    try {
      return JSON.parse(raw) as ModEntry[];
    } catch (e) {
      throw new Error(`Failed to parse mod registry at ${this.file}: ${(e as Error).message}`);
    }
  }

  async get(id: string): Promise<ModEntry | undefined> {
    return (await this.load()).find((m) => m.id === id);
  }

  async upsert(entry: ModEntry): Promise<void> {
    const all = (await this.load()).filter((m) => m.id !== entry.id);
    all.push(entry);
    await this.write(all);
  }

  async remove(id: string): Promise<ModEntry | undefined> {
    const all = await this.load();
    const found = all.find((m) => m.id === id);
    if (!found) return undefined;
    await this.write(all.filter((m) => m.id !== id));
    return found;
  }

  private async write(entries: ModEntry[]): Promise<void> {
    await writeFile(this.file, JSON.stringify(entries, null, 2), "utf8");
  }
}
