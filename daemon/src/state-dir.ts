import { join } from "node:path";

/**
 * Where the daemon keeps everything it cannot re-download: config.json,
 * mods.json, the mod library and the per-world sets.
 *
 * Deliberately NOT the daemon's own directory. State beside `dist/` makes
 * "delete the folder and unzip the new release" destroy the only copy of every
 * uploaded jar, and a README can warn about that but cannot prevent it. With
 * state here the install directory holds nothing irreplaceable, so
 * delete-and-replace becomes the correct upgrade rather than the dangerous one.
 *
 * Read on every call rather than cached at module load: tests set the override
 * per case, and a cached value would leak the first test's directory into the
 * rest of the file.
 */
export function stateDir(): string {
  const override = process.env.NECESSE_MANAGER_DATA;
  if (override !== undefined && override.trim().length > 0) return override;
  const programData = process.env.PROGRAMDATA;
  if (programData !== undefined && programData.trim().length > 0) {
    return join(programData, "NecesseServerManager");
  }
  throw new Error(
    "Cannot determine the daemon's state directory: neither NECESSE_MANAGER_DATA " +
      "nor PROGRAMDATA is set in this environment. Set NECESSE_MANAGER_DATA to an " +
      "absolute path to choose one explicitly.",
  );
}

export function stateFile(name: string): string {
  return join(stateDir(), name);
}

/**
 * Where a refused boot leaves its explanation.
 *
 * The daemon normally runs as a Scheduled Task, whose stdout goes nowhere at
 * all, so a refusal printed to the console is a refusal nobody ever reads -
 * the only symptom is a task that will not stay Running.
 *
 * `stateDirPopulated` deliberately ignores this name. The legacy-state refusal
 * writes the file into a state directory it has just declared empty, and if
 * that counted as populated the next boot would conclude the migration had
 * already happened and start against an empty state directory - the exact
 * outcome the refusal exists to prevent.
 */
export const BOOT_REFUSAL_FILE = "boot-refusal.txt";

/** What an install predating the state directory kept beside `dist/`. */
export const LEGACY_STATE_FILES = [
  "config.json",
  "mods.json",
  "mod-sets.json",
  "mod-library.json",
] as const;

export const LEGACY_STATE_DIRS = ["mod-library"] as const;
