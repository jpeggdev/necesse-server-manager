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
 * Runs once: a default owner already present means the migration has happened
 * (or the operator has chosen one), and nothing is touched.
 */
export async function migrateOwners(
  storedOwners: unknown,
  store: LaunchOptions,
): Promise<string | null> {
  if (!Array.isArray(storedOwners)) return null;
  const names = storedOwners.filter((o): o is string => typeof o === "string" && o.trim().length > 0);
  if (names.length === 0) return null;

  const existing = await store.defaults();
  if (typeof existing.owner === "string") return null;

  const chosen = names[0];
  await store.setDefaults({ owner: chosen });
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
