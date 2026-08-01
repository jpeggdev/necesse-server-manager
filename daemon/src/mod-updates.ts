import type { ModEntry, WorkshopItem } from "./types.js";

/**
 * Whether the workshop entry we installed from is the entry Steam has now.
 *
 * The one place this comparison lives. `GET /api/mods/updates` paints badges
 * from it and `ModInstaller.updateAll` decides whether to download from it; if
 * they each had their own copy they could disagree, and the client would show
 * "update available" on a mod that Update All then skips. Both would look
 * correct in isolation, which is what would make it hard to find.
 *
 * False whenever the answer is not knowable - no entry, no timestamp on the
 * entry, nothing recorded for the installed jar. Unknown means "might have
 * changed", so the caller refetches rather than guessing.
 */
export function workshopEntryUnchanged(
  stored: ModEntry["workshopUpdatedAt"],
  entry: Pick<WorkshopItem, "updatedAt"> | undefined,
): boolean {
  if (entry === undefined) return false;
  if (entry.updatedAt === null) return false;
  if (stored === null) return false;
  return stored === entry.updatedAt;
}
