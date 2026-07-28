# Mod sets and the mod library

Per-world mod selections, a shared library of available jars, and jar upload.

## The problem

Today one folder — `%APPDATA%\Necesse\mods` — is the mod set for every world.
Playing a modded world means hand-swapping jars and remembering what belonged
to which world. As of 2026-07-27 the live server showed exactly this: Aphorea
Mod removed and `SummonerExpansion-1.2.0-7.7.jar` dropped in by hand, where it
appeared as *untracked* because the app never installed it.

## Decisions

| Question | Decision |
|---|---|
| Does a set follow mod updates? | **Yes.** Sets reference mod identity, not a jar version. `Update All` refreshes the library and every world picks the new version up at its next start. |
| Removing a mod whose content is in the save? | **Warn clearly, allow it.** The operator decides; the app must not pretend it is safe. |
| UI shape | Checkboxes in the mods panel, reflecting the world currently in the header's world field. |

## Mod identity: `mod.info`, not the filename or the workshop id

Every Necesse mod jar carries `mod.info` at its root, in the same config format
as `worldSettings.cfg`:

```
{
	id = aphoreateam.aphoreamod,
	name = Aphorea Mod,
	version = 1.0.38,
	gameVersion = 1.2.0,
	author = AphoreaTeam,
	description = ...,
	clientside = false
}
```

`id` is the library key. It is what the game itself records in `modlist.data`,
it is stable across versions, and it is identical whether a jar arrived from
the workshop or by upload — so the same mod from two sources unifies instead of
duplicating. A jar filename carries its version (`AutoTorch-1.0.jar` →
`-1.1.jar`), so a set stored as filenames would break on every update. A
workshop id does not exist for uploads.

**Upload validation follows from this:** a jar with no parseable `mod.info`
carrying an `id` is not a Necesse mod, and is rejected saying so.

## Where things live

| | |
|---|---|
| Library jars | `<daemonDir>\mod-library\<safe-mod-id>\<original>.jar` |
| Library manifest | `<daemonDir>\mod-library.json` |
| Per-world sets | `<daemonDir>\mod-sets.json` |
| What the server loads | `%APPDATA%\Necesse\mods` — unchanged, still the only folder the game reads |

**Not `C:\necesseserver`.** That tree is steamcmd-managed — it holds
`steamapps\appmanifest_1169370.acf` — and this app's own Update Server button
runs `app_update 1169370 validate`, which reconciles the tree against Steam's
manifest. Anything we put there is an unknown file that a validate pass may
prune. `C:\necesseserver\mods` exists but is empty and unused; the server reads
AppData.

A per-mod-id subfolder keeps the original filename (recognisable, and what the
game logs) while making two mods that happen to ship the same jar name
impossible to collide.

**One jar per id is *current*; every other jar is kept.** The mods folder may
only hold one jar per mod — two is what makes the game load a mod twice — but
the library keeps all of them, because it is the only copy of a hand-placed or
uploaded jar and reconcile deletes from the folder on the strength of the
library holding those bytes. A new version therefore supersedes the old one
rather than overwriting it, and a jar arriving under a filename already in use
is stored under a disambiguated name rather than on top of what is there.

## Reconciling before start

Start becomes: reconcile the mods folder to the world's set, then spawn. Only
when the server is verified stopped and no task is in flight.

1. Read the mods folder: every jar's `mod.info`, and a hash of its bytes.
2. **Adopt before pruning.** Any jar whose exact bytes the library does not
   already hold is copied *into* the library first, as a local entry — every
   jar, including the loser of a duplicate pair, since step 4 deletes those too.
   Adoption never promotes: it does not change which jar is current, so
   dropping an old jar into the folder cannot silently downgrade a world.
3. Resolve each id in the set to its current library jar; refuse if any is
   missing, or if two of them share a filename.
4. Delete jars in the mods folder that the set does not name.
5. Copy in the set's jars that are missing, then verify the folder contains
   exactly the set, then spawn.

**Invariant: never delete a jar the library cannot restore — *that* jar, not
merely something else carrying the same mod id.** Two versions of one mod are
two different files: the library holding `Mod-1.0.jar` does nothing for a
hand-dropped `Mod-2.0.jar` that may be the only copy in existence. So step 2's
test is a **hash of the bytes**, never the mod id — gating on the id deletes
exactly that jar, which is the bug this wording exists to prevent recurring.

If any step fails the server does not start and the failure is reported — a
half-reconciled mods folder must never be launched, because the game would
silently run a set nobody chose.

**An install or `Update All` writes the new jar into the library** and makes it
current. Without that, reconcile would restore the older jar at the next start
and the update would be silently undone; the library, not the mods folder, is
what a set is applied from.

## Migration

The library is seeded from the current mods folder plus the workshop cache;
`SummonerExpansion` is adopted as a local entry. Every existing world's set is
seeded with exactly what is installed right now, so the first start after this
ships loads precisely what the previous start loaded. Nothing changes until a
set is deliberately edited.

## Things that can go wrong, and what is done about them

- **Removing a mod whose content is placed in the world.** Genuine
  save-corruption path. Warned, not blocked.
- **A set naming a mod the library no longer has.** Start refuses rather than
  launching a partial set.
- **Two jars with the same mod id** (an old and a new version both present).
  The game would load the mod twice, so reconcile writes one jar per id. Which
  one is a **heuristic** — higher declared `mod.info` version, then the
  later-sorting filename, because mods routinely ship a new build without
  bumping the declared version. A heuristic is acceptable only because both jars
  are retained in the library first: a wrong guess costs a start with the wrong
  build and is undone by pointing the set at the other one.
- **Two mods whose jars share a filename.** Only one can exist in the mods
  folder, so reconcile refuses before writing, naming both mods and the
  filename. Letting the verify step catch it instead gives "some mod is not
  there", which is an unstartable world with no actionable diagnosis.
- **A mod's `gameVersion` not matching the server's.** Recorded from
  `mod.info` and surfaced; not enforced, since the game itself decides.
