import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { BOOT_REFUSAL_FILE, LEGACY_STATE_DIRS, LEGACY_STATE_FILES } from "./state-dir.js";

const present = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Failed to check ${p}: ${(e as Error).message}`);
  }
};

/** Which pre-move state entries this install directory still holds. */
export async function findLegacyState(installDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of [...LEGACY_STATE_FILES, ...LEGACY_STATE_DIRS]) {
    if (await present(join(installDir, name))) found.push(name);
  }
  return found;
}

/**
 * Whether the state directory already holds anything worth keeping.
 *
 * The boot-refusal log does not count. It is written by the very refusal this
 * predicate produces, so counting it would make the second boot after a
 * refusal decide the migration had already happened - see BOOT_REFUSAL_FILE.
 */
export async function stateDirPopulated(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).some((name) => name !== BOOT_REFUSAL_FILE);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Failed to read the state directory ${dir}: ${(e as Error).message}`);
  }
}

/**
 * Composes the three legacy-state checks the way the daemon does at every
 * boot: null when it is safe to proceed - no legacy state exists, or the
 * state directory already holds a migrated copy of it - or the refusal
 * message naming both directories when a real legacy install would otherwise
 * boot silently against an empty state directory.
 *
 * Extracted out of `index.ts` so the composition itself is testable: getting
 * the "and the state directory is not already populated" condition backwards,
 * or swapping which directory plays which role in the message, would each
 * pass every other test in the suite untouched.
 */
export async function resolveLegacyState(installDir: string, dir: string): Promise<string | null> {
  const found = await findLegacyState(installDir);
  if (found.length === 0) return null;
  if (await stateDirPopulated(dir)) return null;
  return legacyStateRefusal(installDir, found, dir);
}

export function legacyStateRefusal(installDir: string, found: string[], dir: string): string {
  return (
    `This daemon keeps its state in ${dir}, but ${installDir} still holds an older ` +
    `install's state (${found.join(", ")}) and the state directory is empty.\n\n` +
    `Run migrate.cmd from the install folder to copy it across. It copies rather than moves ` +
    `and verifies what it wrote, so the originals stay where they are until you delete them.\n\n` +
    `The daemon refuses to start rather than migrating on its own: mod-library holds the only ` +
    `copy of every uploaded and hand-placed jar, and moving that is not something a restart ` +
    `should do by itself.`
  );
}

/**
 * Copies pre-move state into the state directory and reads back what it wrote.
 *
 * Copies, never moves: a migration that fails halfway through a move has taken
 * the only copy of a jar with it. The originals are left for a human to delete
 * once the daemon is confirmed healthy, which is deliberately a separate
 * decision from running this.
 */
export async function migrateState(
  installDir: string,
  dir: string,
): Promise<{ copied: string[] }> {
  await mkdir(dir, { recursive: true });
  const copied: string[] = [];

  for (const name of LEGACY_STATE_FILES) {
    const from = join(installDir, name);
    if (!(await present(from))) continue;
    const to = join(dir, name);
    if (await present(to)) {
      throw new Error(
        `${to} already exists. Migration refuses to overwrite state that is already in ` +
          `place - compare the two by hand and delete the one you do not want.`,
      );
    }
    const bytes = await readFile(from);
    await cp(from, to);
    const back = await readFile(to);
    if (!back.equals(bytes)) {
      throw new Error(`${to} does not match ${from} after copying. Nothing was deleted.`);
    }
    copied.push(name);
  }

  for (const name of LEGACY_STATE_DIRS) {
    const from = join(installDir, name);
    if (!(await present(from))) continue;
    const to = join(dir, name);
    if (await present(to)) {
      throw new Error(
        `${to} already exists. Migration refuses to merge two mod libraries - compare them ` +
          `by hand and delete the one you do not want.`,
      );
    }
    await cp(from, to, { recursive: true });
    await verifyTree(from, to);
    copied.push(name);
  }

  return { copied };
}

/**
 * Verifies that every file under `from` exists under `to` with identical bytes.
 * Exported because it is load-bearing: a verification that cannot be tested
 * independently of the copy it follows is not pinned by any test.
 */
export async function verifyTree(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const a = join(from, entry.name);
    const b = join(to, entry.name);
    if (entry.isDirectory()) {
      await verifyTree(a, b);
      continue;
    }
    const [x, y] = await Promise.all([readFile(a), readFile(b)]);
    if (!x.equals(y)) throw new Error(`${b} does not match ${a} after copying. Nothing was deleted.`);
  }
}
