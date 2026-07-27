import { readFile, writeFile } from "node:fs/promises";
import type { DaemonConfig } from "./types.js";

export const DEFAULT_CONFIG: DaemonConfig = {
  port: 8710,
  serverRoot: "C:\\necesseserver",
  javaExe: "C:\\necesseserver\\jre\\bin\\java.exe",
  serverJar: "C:\\necesseserver\\Server.jar",
  steamcmdExe: "C:\\Users\\jeffp\\steam\\steamcmd.exe",
  modsDir: "C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\mods",
  worldsDir: "C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\saves\\worlds",
  jvmArgs: [
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:+UseG1GC",
    "-XX:+ExplicitGCInvokesConcurrent",
    "-XX:G1NewSizePercent=20",
    "-XX:G1ReservePercent=20",
    "-XX:MaxGCPauseMillis=50",
    "-XX:G1HeapRegionSize=32M",
  ],
  owners: [],
  lastWorld: null,
  serverAppId: 1169370,
  workshopAppId: 1169040,
  stopTimeoutMs: 90_000,
  // Empty by design. The real key is written into config.json on the server
  // itself and must never enter the repo; every Steam call except workshop
  // search works anonymously without it.
  steamApiKey: "",
};

/**
 * A BOM is compared by code point rather than written as a string literal:
 * an invisible character in source is unreadable, and an escape for one is
 * easy to mangle into a literal backslash while editing.
 */
const BOM_CODE_POINT = 0xfeff;

function stripBom(text: string): string {
  return text.charCodeAt(0) === BOM_CODE_POINT ? text.slice(1) : text;
}

export async function loadConfig(file: string): Promise<DaemonConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Failed to read config at ${file}: ${(e as Error).message}`);
    }
    const cfg = { ...DEFAULT_CONFIG };
    await saveConfig(file, cfg);
    return cfg;
  }
  let parsed: Partial<DaemonConfig>;
  try {
    // Hand-editing this file on Windows is the documented way to set the Steam
    // key, and Notepad, VS Code and PowerShell's Set-Content -Encoding UTF8 all
    // add a BOM that JSON.parse rejects. Tolerate it rather than refuse to boot.
    parsed = JSON.parse(stripBom(raw));
  } catch (e) {
    throw new Error(`Failed to parse config at ${file}: ${(e as Error).message}`);
  }
  return { ...DEFAULT_CONFIG, ...parsed };
}

export async function saveConfig(file: string, cfg: DaemonConfig): Promise<void> {
  await writeFile(file, JSON.stringify(cfg, null, 2), "utf8");
}
