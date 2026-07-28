/**
 * Whether two world names name the same world.
 *
 * Every per-world payload in this client is held across the moment the world
 * changes: a component keeps the previous world's fields, set or error for the
 * length of the request that will replace them. Rendering one world's answer
 * under another world's name is not a cosmetic lag - it is what lets a diff be
 * computed against the wrong baseline and written to the wrong world. Each
 * response carries the world it describes, and that name is the only thing that
 * can tell the two apart, so this is the comparison every one of them makes
 * before adopting anything.
 *
 * The daemon's own normalisation, copied rather than approximated:
 * `normaliseWorld` in `daemon/src/mod-sets.ts` trims and lowercases, so a set
 * asked about as "tulsa " is found under "Tulsa" and the response echoes the
 * name as it was last written. Comparing exactly would make a legitimate answer
 * look like another world's and leave the caller waiting forever for one that
 * has already arrived. Two worlds cannot differ only by case in the first place:
 * `listWorlds` reads names off NTFS, which will not hold both.
 */
export function sameWorld(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
