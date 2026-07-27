import { useState } from "react";
import { WorkshopSearch } from "./WorkshopSearch";
import type { ModListResponse, ModUpdateInfo, WorkshopSearchResponse } from "./types";

export interface ModsPanelProps {
  mods: ModListResponse;
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

export function ModsPanel({
  mods,
  updates = null,
  updatesError = null,
  busy,
  running,
  onAdd,
  onRemove,
  onUpdateAll,
  onSearch,
}: ModsPanelProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [searching, setSearching] = useState(false);
  const locked = busy || running;
  // The name is optional now, so only the id gates the button. The numeric
  // check stays client-side: an id that cannot possibly be a workshop id is
  // not worth a round trip, and the daemon rejects it with a 400 anyway.
  const canAdd = !locked && /^\d+$/.test(id.trim());

  const updateById = new Map((updates ?? []).map((u) => [u.id, u]));
  // The thumbnail slot is reserved for every managed row, or for none: a
  // per-row `previewUrl.length > 0` would leave names ragged, since Steam has
  // no entry for some ids. Reserved only once the check has actually landed,
  // so a Steam outage leaves the list exactly as it was before this existed
  // rather than adding a column of empty boxes.
  const showThumbs = updates !== null;

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
          {running && <p className="hint hint-warn">Stop the server to change mods.</p>}
          {!running && busy && (
            <p className="hint hint-warn">A task is already running &mdash; wait for it to finish.</p>
          )}
          {updatesError !== null && mods.managed.length > 0 && (
            <p className="hint">Update check unavailable: {updatesError}</p>
          )}

          <ul className={showThumbs ? "mod-list with-thumbs" : "mod-list"}>
            {mods.managed.map((m) => {
              const u = updateById.get(m.id);
              const rowTitle = [
                m.name,
                `Workshop id: ${m.id}`,
                `Jar: ${m.jar}`,
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
                  <button
                    className="x"
                    aria-label={`Remove ${m.name}`}
                    disabled={locked}
                    onClick={() => onRemove(m.id)}
                  >
                    &times;
                  </button>
                  {showThumbs &&
                    (u !== undefined && u.previewUrl.length > 0 ? (
                      // Decorative: the name is right beside it.
                      <img className="mod-thumb" src={u.previewUrl} alt="" loading="lazy" />
                    ) : (
                      <span className="mod-thumb mod-thumb-empty" />
                    ))}
                  <span className="mod-name">{m.name}</span>
                  {u?.updateAvailable === true && (
                    <span className="mod-tag mod-tag-update" title={UPDATE_HINT}>
                      may be newer
                    </span>
                  )}
                </li>
              );
            })}
            {mods.untracked.map((u) => (
              <li
                key={u.jar}
                className="untracked"
                title={`${u.jar}\nUntracked — no workshop id, so this mod cannot be updated`}
              >
                <span className="mod-name">{u.jar}</span>
                <span className="mod-tag">untracked</span>
              </li>
            ))}
          </ul>

          <div className="mod-add">
            <label htmlFor="mod-id">Mod id</label>
            <input id="mod-id" value={id} disabled={locked} onChange={(e) => setId(e.target.value)} />
            <label htmlFor="mod-name">Mod name</label>
            <input id="mod-name" value={name} disabled={locked} onChange={(e) => setName(e.target.value)} />
            <p className="hint mod-add-hint">
              Leave the name empty and the daemon will look the title up on Steam.
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
          </div>
        </>
      )}
    </section>
  );
}
