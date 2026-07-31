import { readStoredConfig } from "./config.js";
import { checkLaunchOption } from "./launch-options-schema.js";
import type { LaunchOptions } from "./launch-options.js";

/**
 * Moves `config.json`'s retired `owners` array to the default launch owner.
 *
 * The array modelled something the game does not have. `parseLaunchOptions`
 * accumulates into a map, so repeated `-owner` flags overwrite and only the
 * LAST survives - an install with two owners has silently had one this whole
 * time. Seeding the FIRST entry is therefore a deliberate behaviour change: at
 * the next start of any world, owner permissions move to that name. It is the
 * fix this feature exists to deliver, and the returned message is what stops it
 * being another silent change.
 *
 * Runs at most once, and the guard is a durable marker in
 * `launch-options.json` rather than a look at current state. `owners` is never
 * removed from `config.json` - `loadConfig`/`saveConfig` round-trip it - so
 * inferring "already migrated" from "a default owner exists" meant an operator
 * who deliberately cleared the default owner had it silently re-seeded from
 * that stale array at the next daemon start. An install that already has a
 * default owner (because it migrated before the marker existed, or because
 * someone chose one) is recorded as migrated and left alone.
 */
export async function migrateOwners(
  storedOwners: unknown,
  store: LaunchOptions,
): Promise<string | null> {
  if (!Array.isArray(storedOwners)) return null;
  // Trimmed, not just filtered on the trimmed form: storing the original would
  // put the leading or trailing whitespace on the game's command line.
  const names = storedOwners
    .filter((o): o is string => typeof o === "string" && o.trim().length > 0)
    .map((o) => o.trim());
  if (names.length === 0) return null;

  if (await store.ownersMigrated()) return null;

  const existing = await store.defaults();
  if (typeof existing.owner === "string") {
    await store.markOwnersMigrated();
    return null;
  }

  const chosen = names[0];

  // The same check the HTTP routes apply, CALLED rather than copied so the two
  // can never drift apart. config.json is hand-edited on the server box, so a
  // name arriving here is boundary input exactly as a client's PUT is - and
  // this is the one path into the store that does not already go through a
  // route. Without it a legacy `owners` entry like `Jeff -settings C:/x.cfg`
  // would be seeded here and then emitted onto the game's command line, which
  // is precisely what that validation exists to prevent.
  const bad = checkLaunchOption("owner", chosen);
  if (bad !== null) {
    // Not seeded, not thrown, and deliberately NOT marked migrated: the
    // migration did not happen, so it must stay pending. That makes the
    // warning repeat at every boot until the operator either fixes the array
    // in config.json or sets a valid owner from the client - and the latter
    // trips the "already has an owner" branch above, which marks it migrated
    // and stops the warning. Unresolved stays visible; resolved goes quiet.
    return (
      `config.json's owners array starts with ${JSON.stringify(chosen)}, which cannot be used ` +
      `as the default launch owner: ${bad} No owner was migrated, so every world will start ` +
      `without -owner until you set a valid one from the client's launch options.`
    );
  }

  await store.setDefaults({ owner: chosen });
  await store.markOwnersMigrated();
  if (names.length === 1) {
    return `Moved the configured owner "${chosen}" from config.json into the default launch options.`;
  }
  return (
    `config.json listed ${names.length} owners (${names.join(", ")}), but the game accepts one: ` +
    `repeated -owner flags overwrite, so this server has been applying "${names[names.length - 1]}". ` +
    `The default owner is now "${chosen}", which takes effect at the next world start. ` +
    `Set a different owner per world from the client if you want one.`
  );
}

/** What running the owner migration at boot produced, for `index.ts` to log and publish. */
export interface OwnerMigrationOutcome {
  /** null when there was nothing to do - no message to log or publish. */
  message: string | null;
  /**
   * True when the migration could not be attempted at all - `config.json` or
   * `launch-options.json` could not be read or parsed. It does NOT cover a
   * migration that ran and declined to seed a value it refused (an owner name
   * the game would re-parse as a flag): that is a completed run reporting a
   * decision, and it reports through `message` like every other outcome. The
   * caller uses this only to choose console.warn versus console.error; either
   * way `message` still belongs in configWarnings, which is the channel that
   * actually reaches an operator.
   */
  failed: boolean;
}

/**
 * Runs the owner migration and turns whatever happens - success, nothing to
 * do, or failure - into exactly one outcome for `index.ts` to act on.
 *
 * Split out of `index.ts` so the failure path is unit-testable: that script
 * is a top-level module with side effects at import and has no test coverage
 * of any kind. A read or parse failure here (a corrupt `config.json` or
 * `launch-options.json`) must not take the whole daemon down - see
 * `migrateOwners`'s doc comment - but it also must not go unreported the way
 * a bare console.error would under the Scheduled Task this daemon runs as,
 * whose stdout nobody reads. The failure message is not a paraphrase: it
 * carries the config path and `(e as Error).message` verbatim, same as every
 * other error in this codebase.
 */
export async function runOwnerMigration(
  configFile: string,
  store: LaunchOptions,
): Promise<OwnerMigrationOutcome> {
  try {
    const stored = await readStoredConfig(configFile);
    const message = await migrateOwners((stored as { owners?: unknown }).owners, store);
    return { message, failed: false };
  } catch (e) {
    return {
      message:
        `Owner migration failed (config: ${configFile}): ${(e as Error).message}. The default ` +
        `launch owner was not seeded, so every world will start without -owner until one is set ` +
        `from the client.`,
      failed: true,
    };
  }
}
