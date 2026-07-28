import { useEffect, useState } from "react";
import { WorkshopSearch } from "./WorkshopSearch";
import { sameWorld } from "./world-name";
import type {
  ModLibraryEntry,
  ModListResponse,
  ModUpdateInfo,
  ModUploadResponse,
  WorkshopSearchResponse,
  WorldModsResponse,
} from "./types";

export interface ModsPanelProps {
  mods: ModListResponse;
  /**
   * Every mod the daemon holds a jar for, whatever any world loads. This, not
   * the mods folder, is what a world's set is chosen from: the folder only ever
   * holds one world's worth at a time, so a list built from it could not offer
   * a mod that another world uses.
   */
  library: ModLibraryEntry[];
  /**
   * Why the library could not be read, when it could not. Empty-with-a-reason
   * is a different thing from empty, and this is the only place that says which:
   * a daemon too old to have the endpoint answers 404 here, and everything else
   * in the app keeps working.
   */
  libraryError?: string | null;
  /**
   * Per-mod workshop update status, or null when it is unknown - before the
   * first check lands, or after one failed. Null renders no badges; it never
   * renders "up to date".
   */
  updates?: ModUpdateInfo[] | null;
  /** Why the update check has nothing to say. Shown as a quiet hint, not an error. */
  updatesError?: string | null;
  /** True while a mod/server task is streaming - the game only reads mods at startup, so a second mutation must wait. */
  busy: boolean;
  running: boolean;
  /**
   * The world the header's field names, once that name has been confirmed, or
   * null while there is none. The checkboxes below are that world's set, so this
   * is deliberately the *confirmed* name rather than the raw field: showing a
   * set for a name the daemon has not answered about yet is the same staleness
   * bug the header's own candidate gate exists to prevent.
   */
  world?: string | null;
  /** That world's set, or null while it is being read. */
  worldMods?: WorldModsResponse | null;
  /**
   * Why the set could not be read, and which world it was being read for.
   *
   * Tagged with the world for the same reason the payload is checked against
   * one: it is held across a world change too, and an untagged string renders
   * the previous world's failure under the new world's name - which reads as
   * "this world is broken" about a world nothing has been asked about yet.
   */
  worldModsError?: { world: string; message: string } | null;
  /** Writes the world's set. Absent means set editing is not offered. */
  onSaveSet?: (modIds: string[]) => Promise<WorldModsResponse>;
  /** Puts a jar into the library. Absent means upload is not offered. */
  onUpload?: (file: File) => Promise<ModUploadResponse>;
  /** `name` is optional: with none, the daemon resolves the title from Steam. */
  onAdd: (id: string, name?: string) => void;
  onRemove: (id: string) => void;
  onUpdateAll: () => void;
  /** Runs GET /api/workshop/search. Absent means the search view is not offered. */
  onSearch?: (q: string, cursor?: string) => Promise<WorkshopSearchResponse>;
}

/**
 * Steam moves `time_updated` for ANY edit to a workshop entry - a retitle, a
 * description tweak, a new screenshot - so this is an indication, not a
 * promise. Both the badge text and this tooltip are worded to say so.
 */
const UPDATE_HINT =
  "The workshop entry changed after this copy was installed. That may be a new version, " +
  "or only an edit to the title, description or screenshots - Steam does not say which.";

/**
 * The two reasons this panel refuses to change anything, as one string each.
 *
 * They are the text of the hint at the top of the panel AND the title of every
 * control they disable, so a greyed-out checkbox and the sentence explaining it
 * can never drift apart. Adding a set to that list rather than inventing a
 * second mechanism for it is the point: the game reads its mods once, at
 * startup, and everything that decides what it reads waits on the same two
 * conditions.
 */
const RUNNING_REASON = "Stop the server to change mods.";
const BUSY_REASON = "A task is already running - wait for it to finish.";

/** A jar's size for a human. Upload is the only place a byte count is shown. */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function ModsPanel({
  mods,
  library,
  libraryError = null,
  updates = null,
  updatesError = null,
  busy,
  running,
  world = null,
  worldMods = null,
  worldModsError = null,
  onSaveSet,
  onUpload,
  onAdd,
  onRemove,
  onUpdateAll,
  onSearch,
}: ModsPanelProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [searching, setSearching] = useState(false);
  /**
   * The set as edited, or null when nothing has been ticked since it was last
   * read. Null rather than a copy of the saved ids so that a set changed by
   * something else - another client, a start that seeded one - shows through
   * instead of being masked by a stale copy of what this panel saw first.
   */
  const [selection, setSelection] = useState<string[] | null>(null);
  const [savingSet, setSavingSet] = useState(false);
  /**
   * A save failure, tagged with the world it was a save of. The success message
   * names its world in its own text; this one carries the daemon's words
   * verbatim, which say nothing about which world, so the tag is what stops a
   * refusal for one world appearing under another.
   */
  const [setError, setSetError] = useState<{ world: string; message: string } | null>(null);
  const [setSaved, setSetSaved] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  // Bumped after a successful upload to remount the file input, which is the
  // only way to clear a file picker's own selection.
  const [pickerKey, setPickerKey] = useState(0);

  const locked = busy || running;
  // The name is optional now, so only the id gates the button. The numeric
  // check stays client-side: an id that cannot possibly be a workshop id is
  // not worth a round trip, and the daemon rejects it with a 400 anyway.
  const canAdd = !locked && /^\d+$/.test(id.trim());

  /**
   * The set, but only when the payload in hand is actually this world's.
   *
   * A world change and the read that answers it are not simultaneous: the GET
   * takes as long as it takes - for an unconfigured world it unzips every jar in
   * the mods folder - and until it lands the caller is still holding the
   * PREVIOUS world's payload. Rendering that is not a cosmetic lag: the ticks
   * are the previous world's, the removal diff is computed against the previous
   * world's baseline, and Save writes them to the new world. The response names
   * the world it describes, so that name is what decides, and everything below
   * treats a mismatch exactly like "not read yet".
   *
   * Compared with `sameWorld`, which is the daemon's own normalisation: it looks
   * a set up trimmed and lowercased and echoes the name back as it was last
   * written, so asking about "tulsa" legitimately answers "Tulsa" and an exact
   * match would leave this permanently "reading".
   */
  const set =
    worldMods !== null && world !== null && sameWorld(worldMods.world, world)
      ? worldMods
      : null;
  /** The read failure, on the same terms: this world's, or none. */
  const readError =
    worldModsError !== null && world !== null && sameWorld(worldModsError.world, world)
      ? worldModsError.message
      : null;
  const saved = set?.modIds ?? [];
  /**
   * Identity of the set as saved. The pending edit is dropped when this
   * changes - a different world, or the same world's set changed underneath -
   * and deliberately NOT when `worldMods` merely arrives again as a new object:
   * every refresh re-reads it, and discarding half-ticked boxes because a mod
   * install finished would be its own small betrayal.
   */
  const savedKey = JSON.stringify([world, set?.configured, saved]);
  useEffect(() => setSelection(null), [savedKey]);
  // Messages describe one world's set, so they go when the world does. Keyed on
  // the world alone, not on savedKey: a save changes savedKey, and clearing the
  // confirmation the save just produced would make a successful write look like
  // nothing happened.
  useEffect(() => {
    setSetError(null);
    setSetSaved(null);
  }, [world]);

  const checked = selection ?? saved;
  const checkedSet = new Set(checked);
  const added = checked.filter((m) => !saved.includes(m));
  const removed = saved.filter((m) => !checked.includes(m));
  const dirty = added.length > 0 || removed.length > 0;

  const updateById = new Map((updates ?? []).map((u) => [u.id, u]));
  const managedIds = new Set(mods.managed.map((m) => m.id));
  const nameOf = (modId: string): string =>
    library.find((m) => m.id === modId)?.name ?? modId;
  // The thumbnail slot is reserved for every managed row, or for none: a
  // per-row `previewUrl.length > 0` would leave names ragged, since Steam has
  // no entry for some ids. Reserved only once the check has actually landed,
  // so a Steam outage leaves the list exactly as it was before this existed
  // rather than adding a column of empty boxes.
  const showThumbs = updates !== null;

  /**
   * Why the set cannot be edited right now, or null when it can.
   *
   * The two mutation guards first, in the panel's own words, then the two
   * states where there is simply no set to edit. The daemon is the enforcer -
   * it refuses a set change while a task runs - but the running check is this
   * panel's: changing what a world loads while that world is up produces a set
   * the running session is not using, which reads as an edit that did nothing.
   */
  const setBlockedBecause = running
    ? RUNNING_REASON
    : busy
      ? BUSY_REASON
      : onSaveSet === undefined
        ? "Editing a world's mod set is not available."
        : world === null
          ? "Type a world name in the header to choose which mods it loads."
          : set === null
            ? `Reading ${world}'s mod set...`
            : null;
  const setBlocked = setBlockedBecause !== null;

  const toggle = (modId: string): void => {
    setSetSaved(null);
    // The failure was about the ticks as they were; leaving it under new ones
    // makes it look like the edit in front of the user is the rejected one.
    setSetError(null);
    setSelection(
      checkedSet.has(modId) ? checked.filter((m) => m !== modId) : [...checked, modId],
    );
  };

  const saveSet = (): void => {
    if (onSaveSet === undefined || world === null) return;
    // Captured now: the response can land after the header has moved on, and a
    // failure is only about the world it was a save of.
    const forWorld = world;
    setSavingSet(true);
    setSetError(null);
    setSetSaved(null);
    onSaveSet(checked)
      .then((r) => {
        setSelection(null);
        setSetSaved(
          `Saved. ${r.world} loads ${r.modIds.length === 0 ? "no mods" : `${r.modIds.length} ${plural(r.modIds.length, "mod", "mods")}`} at its next start.`,
        );
      })
      // The daemon's own words: it names the ids it has no jar for, which is
      // the only actionable thing in the response.
      .catch((e: Error) => setSetError({ world: forWorld, message: e.message }))
      .finally(() => setSavingSet(false));
  };

  const upload = (): void => {
    if (onUpload === undefined || file === null) return;
    setUploading(true);
    setUploadError(null);
    setUploaded(null);
    onUpload(file)
      .then((r) => {
        setUploaded(
          `${r.mod.name} ${r.mod.version} is in the library` +
            `${r.replaced ? ", replacing the jar that was there for it" : ""}. ` +
            `Tick it above to load it in a world.`,
        );
        setFile(null);
        setPickerKey((k) => k + 1);
      })
      // Verbatim. The daemon has read the jar's own mod.info and says precisely
      // why it is not a Necesse mod; a "could not upload" here would throw that
      // away and leave the user with nothing to act on.
      .catch((e: Error) => setUploadError(e.message))
      .finally(() => setUploading(false));
  };

  // Ids the set names that the library has no jar for. They have no library row
  // of their own, so without one here the only way out of an unstartable world
  // would be to re-add a mod the operator may not have any more.
  const missing = set?.missing ?? [];
  /**
   * Whether those ids actually stop the world starting.
   *
   * Only for a world that HAS a set. For one that has not, the daemon derives
   * the ids from the mods folder and diffs them against the library - so a
   * hand-placed jar shows up here having never been in the library, while
   * reconcile adopts every folder jar into the library before it resolves the
   * set. That world starts perfectly well, and saying it will not is a false
   * alarm about the one thing this panel must be trusted on.
   */
  const missingBlocksStart = set !== null && set.configured;
  // A hand-placed jar shows as untracked until a start adopts it into the
  // library. Once adopted it has a row above, and listing it twice would read
  // as two copies of one mod.
  const libraryJars = new Set(library.map((m) => m.jar.toLowerCase()));
  const untracked = mods.untracked.filter((u) => !libraryJars.has(u.jar.toLowerCase()));
  const rows = [...library].sort((a, b) => a.name.localeCompare(b.name));
  // A mod the registry still manages but the library has no jar for: an install
  // recorded before the library existed, or one whose entry was removed. It gets
  // no set row, so without this it would have no Remove button either and there
  // would be no way to clear it from the UI at all.
  const libraryWorkshopIds = new Set(
    library.flatMap((m) => (m.source.kind === "workshop" ? [m.source.workshopId] : [])),
  );
  const orphans = mods.managed.filter((m) => !libraryWorkshopIds.has(m.id));

  return (
    <section className="mods">
      <div className="mods-head">
        <h2>Mods</h2>
        <div className="mods-head-actions">
          {onSearch !== undefined && (
            <button aria-pressed={searching} onClick={() => setSearching((s) => !s)}>
              {searching ? "Back to mods" : "Search Workshop"}
            </button>
          )}
          {!searching && (
            <button onClick={onUpdateAll} disabled={locked || mods.managed.length === 0}>
              Update All
            </button>
          )}
        </div>
      </div>

      {searching && onSearch !== undefined ? (
        <WorkshopSearch
          search={onSearch}
          onInstall={(workshopId) => onAdd(workshopId)}
          busy={busy}
          running={running}
          installedIds={mods.managed.map((m) => m.id)}
        />
      ) : (
        <>
          {running && <p className="hint hint-warn">{RUNNING_REASON}</p>}
          {!running && busy && <p className="hint hint-warn">{BUSY_REASON}</p>}
          {updatesError !== null && mods.managed.length > 0 && (
            <p className="hint">Update check unavailable: {updatesError}</p>
          )}

          <div className="mod-set-head">
            {libraryError !== null ? (
              <p className="hint hint-bad">{libraryError}</p>
            ) : world === null ? (
              <p className="hint">
                Type a world name in the header to choose which mods it loads.
              </p>
            ) : readError !== null ? (
              <p className="hint hint-bad">
                Could not read {world}&apos;s mod set: {readError}
              </p>
            ) : set === null ? (
              <p className="hint">Reading {world}&apos;s mod set&hellip;</p>
            ) : (
              <>
                <p className="mod-set-world">
                  Mods for <strong>{world}</strong>
                </p>
                {/*
                 * "Nobody has chosen a set" and "the chosen set is empty" are
                 * different worlds and must not read the same. The daemon draws
                 * that line with `configured`; an unconfigured world starts by
                 * adopting whatever is in the mods folder, so what a start would
                 * actually load is stated rather than left to be inferred from a
                 * list of ticks.
                 */}
                {!set.configured ? (
                  <p className="hint hint-warn">
                    No mod set has been chosen for {world} yet.{" "}
                    {saved.length === 0
                      ? "The mods folder is empty, so starting it would load no mods, and that is what would be saved as its set."
                      : `Starting it would load the ${saved.length} ${plural(saved.length, "mod", "mods")} in the mods folder right now (ticked below), and save that as its set.`}
                  </p>
                ) : saved.length === 0 ? (
                  <p className="hint">
                    {world}&apos;s set is empty: starting it loads no mods at all.
                  </p>
                ) : (
                  <p className="hint">
                    {saved.length} {plural(saved.length, "mod", "mods")} chosen; starting {world}{" "}
                    loads exactly {plural(saved.length, "that one", "those")}.
                  </p>
                )}
                {missing.length > 0 &&
                  (missingBlocksStart ? (
                    <p className="hint hint-bad">
                      The library has no jar for {missing.join(", ")}. Unless that jar is sitting in
                      the mods folder for the next start to take in, {world} will not start until{" "}
                      {plural(missing.length, "it is", "they are")} re-added or unticked &mdash; the
                      daemon refuses rather than launching a partial set.
                    </p>
                  ) : (
                    <p className="hint">
                      {missing.join(", ")} {plural(missing.length, "is", "are")} in the mods folder
                      but not in the library yet. Starting {world} takes{" "}
                      {plural(missing.length, "it", "them")} in, so this is not a problem; it is
                      listed so you can untick it before it becomes the set.
                    </p>
                  ))}
              </>
            )}
          </div>

          <ul className={showThumbs ? "mod-list with-thumbs" : "mod-list"}>
            {missing.map((modId) => (
              <li
                key={`missing-${modId}`}
                className={missingBlocksStart ? "missing" : undefined}
                title={
                  missingBlocksStart
                    ? `${modId}\nIn this world's set, but the library has no jar for it. Unless that jar is in the mods folder, the world will not start until it is re-added or unticked.`
                    : `${modId}\nIn the mods folder but not in the library yet. Starting this world takes it in.`
                }
              >
                <input
                  type="checkbox"
                  className="mod-check"
                  id={`mod-set-${modId}`}
                  checked={checkedSet.has(modId)}
                  disabled={setBlocked}
                  title={setBlockedBecause ?? `Untick to take ${modId} out of ${world}'s set`}
                  onChange={() => toggle(modId)}
                />
                {showThumbs && <span className="mod-thumb mod-thumb-empty" />}
                <label className="mod-name" htmlFor={`mod-set-${modId}`}>
                  {modId}
                </label>
                <span className={missingBlocksStart ? "mod-tag mod-tag-missing" : "mod-tag"}>
                  {missingBlocksStart ? "missing" : "in folder"}
                </span>
              </li>
            ))}
            {rows.map((m) => {
              const workshopId = m.source.kind === "workshop" ? m.source.workshopId : null;
              const u = workshopId === null ? undefined : updateById.get(workshopId);
              const rowTitle = [
                m.name,
                `Mod id: ${m.id}`,
                m.source.kind === "workshop"
                  ? `Workshop id: ${m.source.workshopId}`
                  : m.source.how === "upload"
                    ? "Uploaded to this daemon; it has no workshop entry to update from"
                    : "Adopted from the mods folder; it has no workshop entry to update from",
                `Jar: ${m.jar}`,
                `Version ${m.version} for game ${m.gameVersion}`,
                // Kept in the tooltip rather than on the row: the list is for
                // scanning, and a description under every name is exactly the
                // squished list this layout exists to avoid.
                ...(u !== undefined && u.description.length > 0 ? ["", u.description] : []),
                ...(u === undefined
                  ? []
                  : u.updateAvailable
                    ? ["", UPDATE_HINT]
                    : u.onWorkshop
                      ? []
                      : ["", "Steam has no usable entry for this id, so it cannot be checked for updates."]),
              ].join("\n");
              return (
                <li key={m.id} title={rowTitle}>
                  <input
                    type="checkbox"
                    className="mod-check"
                    id={`mod-set-${m.id}`}
                    checked={checkedSet.has(m.id)}
                    disabled={setBlocked}
                    title={
                      setBlockedBecause ?? `Load ${m.name} when ${world} starts`
                    }
                    onChange={() => toggle(m.id)}
                  />
                  {showThumbs &&
                    (u !== undefined && u.previewUrl.length > 0 ? (
                      // Decorative: the name is right beside it.
                      <img className="mod-thumb" src={u.previewUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="mod-thumb mod-thumb-empty" />
                    ))}
                  <label className="mod-name" htmlFor={`mod-set-${m.id}`}>
                    {m.name}
                  </label>
                  {u?.updateAvailable === true && (
                    <span className="mod-tag mod-tag-update" title={UPDATE_HINT}>
                      may be newer
                    </span>
                  )}
                  {workshopId !== null && managedIds.has(workshopId) && (
                    <button
                      className="x"
                      aria-label={`Remove ${m.name}`}
                      disabled={locked}
                      title={`Removes ${m.name} from the mods folder and from the update list. The library keeps its jar, so any world's set can still load it.`}
                      onClick={() => onRemove(workshopId)}
                    >
                      &times;
                    </button>
                  )}
                </li>
              );
            })}
            {orphans.map((m) => (
              <li
                key={`orphan-${m.id}`}
                className="untracked"
                title={`${m.name}\nWorkshop id: ${m.id}\nJar: ${m.jar}\nManaged, but the library has no jar for it, so no world's set can name it. Removing it is all this panel can do with it.`}
              >
                <span className="mod-name">{m.name}</span>
                <span className="mod-tag">not in library</span>
                <button
                  className="x"
                  aria-label={`Remove ${m.name}`}
                  disabled={locked}
                  title={locked ? (running ? RUNNING_REASON : BUSY_REASON) : `Remove ${m.name}`}
                  onClick={() => onRemove(m.id)}
                >
                  &times;
                </button>
              </li>
            ))}
            {untracked.map((u) => (
              <li
                key={u.jar}
                className="untracked"
                title={`${u.jar}\nUntracked - no workshop id, so this mod cannot be updated. It is in the mods folder but not in the library, so no world's set can name it yet; starting any world takes it in.`}
              >
                <span className="mod-name">{u.jar}</span>
                <span className="mod-tag">untracked</span>
              </li>
            ))}
          </ul>

          {world !== null && set !== null && onSaveSet !== undefined && (
            <div className="mod-set-edit">
              {/*
               * Not a confirmation dialog and not a block: the decision is the
               * operator's. But it is a real way to break a save, so it is
               * stated in full, before the write, and it says what actually
               * happens rather than "may cause issues".
               */}
              {removed.length > 0 && (
                <p className="mod-set-danger" role="alert">
                  <strong>
                    Taking {removed.map(nameOf).join(", ")} out of {world}&apos;s set can corrupt
                    that save.
                  </strong>{" "}
                  Anything {plural(removed.length, "that mod", "those mods")} added and that is
                  already placed in the world &mdash; blocks, objects, items sitting in a chest, an
                  NPC &mdash; is content the game no longer has code for. The world may load with
                  all of it gone for good, or fail to load at all. Putting the mod back before the
                  next start is the only undo.
                </p>
              )}
              {dirty && removed.length === 0 && (
                <p className="hint">
                  {added.length} {plural(added.length, "mod", "mods")} added to {world}&apos;s set,
                  not saved yet.
                </p>
              )}
              <div className="mod-set-actions">
                <button
                  onClick={saveSet}
                  disabled={setBlocked || !dirty || savingSet}
                  title={
                    setBlockedBecause ??
                    (dirty
                      ? `Writes ${world}'s mod set. It takes effect at that world's next start, because the game reads its mods once, at startup.`
                      : "Nothing has changed")
                  }
                >
                  {savingSet ? "Saving..." : `Save ${world}'s mod set`}
                </button>
                <button onClick={() => setSelection(null)} disabled={!dirty || savingSet}>
                  Revert
                </button>
              </div>
              {setError !== null && sameWorld(setError.world, world) && (
                <p className="hint hint-bad" role="alert">
                  {setError.message}
                </p>
              )}
              {setSaved !== null && <p className="hint hint-ok">{setSaved}</p>}
            </div>
          )}

          <div className="mod-add">
            <h3>Add to the library</h3>
            <label htmlFor="mod-id">Mod id</label>
            <input id="mod-id" value={id} disabled={locked} onChange={(e) => setId(e.target.value)} />
            <label htmlFor="mod-name">Mod name</label>
            <input id="mod-name" value={name} disabled={locked} onChange={(e) => setName(e.target.value)} />
            <p className="hint mod-add-hint">
              Leave the name empty and the daemon will look the title up on Steam. Installing puts
              the mod in the library; tick it above to make a world load it.
            </p>
            <button
              disabled={!canAdd}
              onClick={() => {
                const typed = name.trim();
                onAdd(id.trim(), typed.length > 0 ? typed : undefined);
                setId("");
                setName("");
              }}
            >
              Add
            </button>

            {onUpload !== undefined && (
              <>
                <label htmlFor="mod-jar">Mod jar</label>
                <input
                  key={pickerKey}
                  id="mod-jar"
                  type="file"
                  accept=".jar,application/java-archive"
                  disabled={busy || uploading}
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setUploadError(null);
                    setUploaded(null);
                  }}
                />
                <p className="hint mod-add-hint">
                  The daemon reads the jar&apos;s own mod.info; a file that is not a Necesse mod is
                  refused with the reason. Uploading only fills the library &mdash; it changes no
                  world&apos;s set, so it is allowed while the server is running.
                </p>
                <button
                  disabled={file === null || uploading || busy}
                  title={busy ? BUSY_REASON : file === null ? "Choose a .jar first" : `Upload ${file.name}`}
                  onClick={upload}
                >
                  {uploading && file !== null
                    ? `Uploading ${file.name} (${fileSize(file.size)})...`
                    : "Upload"}
                </button>
                {/* Indeterminate on purpose: fetch reports no upload progress,
                    and a bar that invented one would be a lie about a transfer
                    that can genuinely take a while. */}
                {uploading && file !== null && (
                  <progress className="mod-upload-progress" aria-label={`Uploading ${file.name}`} />
                )}
                {uploadError !== null && (
                  <p className="hint hint-bad mod-add-hint" role="alert">
                    {uploadError}
                  </p>
                )}
                {uploaded !== null && <p className="hint hint-ok mod-add-hint">{uploaded}</p>}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
