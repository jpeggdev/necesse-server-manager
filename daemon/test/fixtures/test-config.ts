import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, modsDirFor, worldsDirFor } from "../../src/config.js";
import type { DaemonConfig } from "../../src/types.js";

/**
 * A coherent config rooted in a temp directory, with every path it names
 * actually created. Exists because DEFAULT_CONFIG deliberately carries no
 * paths any more: a test that spread it and set two fields would be testing a
 * configuration `configProblems` is supposed to reject.
 */
export function makeTestConfig(root: string): DaemonConfig {
  const dataDir = join(root, "data");
  const serverRoot = join(root, "server");
  const serverJar = join(serverRoot, "Server.jar");
  const javaExe = join(serverRoot, "jre", "bin", "java.exe");
  const steamcmdExe = join(root, "steam", "steamcmd.exe");
  for (const dir of [
    dataDir,
    modsDirFor(dataDir),
    worldsDirFor(dataDir),
    join(serverRoot, "jre", "bin"),
    join(root, "steam"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const file of [serverJar, javaExe, steamcmdExe]) writeFileSync(file, "");
  return {
    ...DEFAULT_CONFIG,
    dataDir,
    modsDir: modsDirFor(dataDir),
    worldsDir: worldsDirFor(dataDir),
    serverRoot,
    serverJar,
    javaExe,
    steamcmdExe,
    modLibraryDir: join(root, "mod-library"),
    modLibraryFile: join(root, "mod-library.json"),
    modSetsFile: join(root, "mod-sets.json"),
  };
}
