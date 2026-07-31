import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "./api";
import { sameWorld } from "./world-name";
import { useModalFocus } from "./useModalFocus";
import type { LaunchOptionField, LaunchOptionsResponse, LaunchOptionValue } from "./types";

/**
 * The sentinel a blank number box holds in `draft`, distinct from any real
 * `LaunchOptionValue`. An `input[type=number]` reports an empty string both
 * for a box the user cleared and for one typed nonsense into, and there is no
 * legal number to substitute for that: `0` is a real, valid override for
 * `itemslife`, `worldborder`, `maxsettlements` and `maxsettlers`, so silently
 * writing it would detach the field from its default exactly as requirement
 * (A) exists to prevent - arrived at from the empty-input direction (B)
 * warns about. `changes` below treats this sentinel as a clear, the same as
 * clicking Revert.
 */
const BLANK_NUMBER = "" as const;

/**
 * What an int box's raw text should stage in `draft`, or `undefined` meaning
 * "not a value yet - leave the field exactly as it is."
 *
 * A blank box stages `BLANK_NUMBER`. Anything else that is not a FINITE
 * number - a bare "-" a user is mid-typing toward a legal "-1" for
 * `worldborder` or `maxsettlers`, or whatever else a real number input hands
 * back that this project's test environment would have sanitized away before
 * `onChange` ever saw it - must never reach `draft`. `sameValue`'s
 * `Number(a) === Number(b)` treats `NaN` as different from everything,
 * including another `NaN`, so it would always read as "changed," and
 * `JSON.stringify(NaN)` serializes to `null` on the wire - an unfinished
 * keystroke would silently clear a saved override with no error and no
 * indication, which is the exact silent-wrong-state shape requirement (A)'s
 * partial-diff and (B)'s null-vs-empty-string discipline both exist to rule
 * out. Ignoring it and waiting for something parseable is the only safe
 * reading of "not a number yet."
 */
export function parseIntBoxValue(raw: string): LaunchOptionValue | undefined {
  if (raw === "") return BLANK_NUMBER;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export interface LaunchOptionsDialogProps {
  world: string;
  api: Api;
  /**
   * The daemon already runs this exact world's process. The dialog still
   * accepts writes in this state - the daemon does too, on purpose - but the
   * game only reads its command line at launch, so nothing here takes effect
   * until the next start. Owned by the caller, which is the only thing that
   * knows what `status` currently says.
   */
  serverRunningThisWorld: boolean;
  onClose: () => void;
}

/**
 * A modal editor for one world's launch options: the daemon-wide defaults
 * with this world's overrides on top.
 *
 * Every field is built from what the daemon reported (`fields`), the same
 * discipline `WorldSettingsDialog` uses for `worldSettings.cfg` - the daemon
 * read the game's own bounds out of `Server.jar`'s launch-arg parser, and a
 * client-side copy would be a second, driftable source of truth.
 *
 * Save sends only the fields the user actually touched. The launch-options
 * write is a full per-world override map: sending the whole form would write
 * an override for every field the user never touched, permanently detaching
 * it from the daemon-wide default - a later change to the default would then
 * silently stop reaching this world. Reverting a field stages an explicit
 * `null`, which is what clears an override; an emptied text box stays an
 * empty STRING, which is a real value the game receives as an empty flag, not
 * a clear.
 */
export function LaunchOptionsDialog({ world, api, serverRunningThisWorld, onClose }: LaunchOptionsDialogProps) {
  const [loaded, setLoaded] = useState<LaunchOptionsResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, LaunchOptionValue>>({});
  /** Field names the user clicked "Revert" on - staged to clear on save. */
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /**
   * Which fields the LAST save actually wrote, captured before `adopt`
   * rebases `draft` onto the response and makes `changes` recompute to `{}`.
   * The confirmation message reads from this, not from `changes`, which by
   * the time it renders always describes zero pending changes whether the
   * save wrote five fields or was never clicked at all.
   */
  const [lastSavedNames, setLastSavedNames] = useState<string[]>([]);

  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const adopt = useCallback((r: LaunchOptionsResponse) => {
    setLoaded(r);
    setDraft(Object.fromEntries(r.fields.map((f) => [f.name, initialValue(f, r)])));
    setCleared(new Set());
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setDraft({});
    setCleared(new Set());
    setLoadError(null);
    setSaveError(null);
    setSaved(false);
    setLastSavedNames([]);
    api
      .launchOptions(world)
      .then((r) => {
        if (cancelled) return;
        // The response names the world it describes (null only for the
        // daemon-wide defaults, which this dialog never requests). Trusting
        // the request we think we made instead would risk adopting an answer
        // about another world in exactly the case this guards against.
        if (r.world !== null && !sameWorld(r.world, world)) return;
        adopt(r);
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, world, adopt]);

  // Escape-to-close, Tab trap, and inert-the-background - shared with
  // WorldSettingsDialog rather than duplicated; see useModalFocus for why.
  useModalFocus(dialogRef, backdropRef, onClose, saving);

  /**
   * Exactly the fields whose staged state differs from what was loaded, in
   * the shape the daemon's PUT expects: a typed value for an edit, `null` for
   * a reverted field, and nothing at all for an untouched one.
   */
  const changes = useMemo(() => {
    if (loaded === null) return {};
    const out: Record<string, LaunchOptionValue | null> = {};
    for (const f of loaded.fields) {
      const wasOverridden = Object.prototype.hasOwnProperty.call(loaded.overrides, f.name);
      if (cleared.has(f.name)) {
        // Reverting a field that was never overridden would clear nothing
        // the daemon has on record - not a change worth sending.
        if (wasOverridden) out[f.name] = null;
        continue;
      }
      const current = draft[f.name];
      if (current === undefined) continue;
      // A number box the user emptied has no legal value to send - see
      // BLANK_NUMBER. Treated exactly like Revert: clears a real override,
      // contributes nothing when there was none to clear.
      if (f.type === "int" && current === BLANK_NUMBER) {
        if (wasOverridden) out[f.name] = null;
        continue;
      }
      const initial = initialValue(f, loaded);
      if (sameValue(f, initial, current)) continue;
      out[f.name] = current;
    }
    return out;
  }, [loaded, draft, cleared]);

  const changedNames = Object.keys(changes);

  const setField = useCallback((name: string, value: LaunchOptionValue) => {
    setSaved(false);
    setSaveError(null);
    // Typing into a reverted field supersedes the revert - it is now an
    // ordinary edit to a new value, not a clear.
    setCleared((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    setDraft((d) => ({ ...d, [name]: value }));
  }, []);

  const revertField = useCallback(
    (field: LaunchOptionField) => {
      if (loaded === null) return;
      setSaved(false);
      setSaveError(null);
      setCleared((prev) => new Set(prev).add(field.name));
      setDraft((d) => ({ ...d, [field.name]: defaultValue(field, loaded) }));
    },
    [loaded],
  );

  const onSave = () => {
    setSaving(true);
    setSaveError(null);
    // Captured before the request, not read from `changes` in the .then -
    // `adopt(r)` rebases `draft` onto the response, which recomputes
    // `changes` to `{}` before the confirmation ever renders.
    const namesBeingSaved = changedNames;
    api
      .saveLaunchOptions(world, changes)
      .then((r) => {
        adopt(r);
        setLastSavedNames(namesBeingSaved);
        setSaved(true);
      })
      .catch((e: Error) => setSaveError(e.message))
      .finally(() => setSaving(false));
  };

  const groups = useMemo(() => (loaded === null ? [] : groupFields(loaded.fields)), [loaded]);

  return (
    <div className="modal-backdrop" ref={backdropRef}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-options-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="modal-head">
          <h2 id="launch-options-title">Launch options &mdash; {world}</h2>
          <button onClick={onClose} disabled={saving} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="modal-body">
          <p className="hint">
            These are the flags the server launches with, layered over the daemon-wide defaults.
            Only the fields you change are written - every other field keeps following the default.
          </p>

          {serverRunningThisWorld && (
            <p role="status" className="hint hint-warn">
              {world} is running right now. Saved changes take effect at its next start, not
              immediately - the game only reads its launch options at launch.
            </p>
          )}

          <p className="hint hint-warn lo-firewall-note">
            Changing the game port needs a firewall rule of its own: register-task.ps1&apos;s rule
            covers the daemon&apos;s own port only, not the port players connect to.
          </p>

          {loadError !== null && <p className="hint hint-bad">{loadError}</p>}

          {loaded === null && loadError === null && <p className="hint">Reading launch options&hellip;</p>}

          {loaded !== null &&
            groups.map(([group, fields]) => (
              <div className="lo-group" key={group}>
                <h3>{groupLabel(group)}</h3>
                <div className="lo-fields">
                  {fields.map((f) => (
                    <FieldRow
                      key={f.name}
                      field={f}
                      value={draft[f.name] ?? initialValue(f, loaded)}
                      inherited={
                        cleared.has(f.name) ||
                        !Object.prototype.hasOwnProperty.call(loaded.overrides, f.name)
                      }
                      disabled={saving}
                      onChange={(v) => setField(f.name, v)}
                      onRevert={() => revertField(f)}
                    />
                  ))}
                </div>
              </div>
            ))}

          {saveError !== null && (
            <p role="alert" className="hint hint-bad">
              {saveError}
            </p>
          )}

          {saved && saveError === null && (
            <p className="hint hint-ok">
              {lastSavedNames.length === 0
                ? "Nothing had changed, so nothing was written."
                : `Saved ${lastSavedNames.join(", ")}.`}
            </p>
          )}
        </div>

        <div className="modal-foot">
          <button onClick={onClose} disabled={saving}>
            {saved ? "Close" : "Cancel"}
          </button>
          <button
            onClick={onSave}
            disabled={saving || loaded === null || changedNames.length === 0}
            title={
              saving
                ? "Saving…"
                : changedNames.length === 0
                  ? "Nothing has been changed yet"
                  : `Writes ${changedNames.join(", ")}`
            }
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface FieldRowProps {
  field: LaunchOptionField;
  value: LaunchOptionValue;
  /**
   * Not overridden for this world (or staged to become that way on save).
   * The only source of truth for whether the Revert control shows too: the
   * two states are exact opposites, so one prop is enough for both.
   */
  inherited: boolean;
  disabled: boolean;
  onChange: (value: LaunchOptionValue) => void;
  onRevert: () => void;
}

function FieldRow({ field, value, inherited, disabled, onChange, onRevert }: FieldRowProps) {
  const id = `lo-${field.name}`;
  return (
    <div className="lo-row">
      <label htmlFor={id}>{field.label}</label>
      {renderControl(field, id, value, disabled, onChange)}
      <p className="hint lo-note">{field.help}</p>
      <p className="hint lo-status">
        {inherited ? (
          "Inherited from defaults."
        ) : (
          <>
            Overridden for this world.{" "}
            <button type="button" onClick={onRevert} disabled={disabled}>
              Revert {field.label} to default
            </button>
          </>
        )}
      </p>
    </div>
  );
}

function renderControl(
  field: LaunchOptionField,
  id: string,
  value: LaunchOptionValue,
  disabled: boolean,
  onChange: (value: LaunchOptionValue) => void,
) {
  switch (field.type) {
    case "boolean":
      return (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "int":
      return (
        <input
          id={id}
          type="number"
          // A blank box shows blank, not a coerced 0 - see BLANK_NUMBER. This
          // is also what keeps a clear-then-type sequence from starting on a
          // phantom leading "0" digit.
          value={value === BLANK_NUMBER ? "" : typeof value === "number" ? value : Number(value)}
          min={field.min}
          max={field.max}
          step={1}
          disabled={disabled}
          onChange={(e) => {
            const parsed = parseIntBoxValue(e.target.value);
            // undefined means "not parseable yet" (e.g. a bare "-" mid-typed
            // toward "-1") - drop the keystroke rather than stage a NaN.
            if (parsed !== undefined) onChange(parsed);
          }}
        />
      );
    case "string":
      return (
        <input
          id={id}
          type="text"
          value={typeof value === "string" ? value : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** Title case for a group id, which is all the daemon's lowercase ids need. */
function groupLabel(group: string): string {
  return group.length === 0 ? group : group[0].toUpperCase() + group.slice(1);
}

/**
 * Fields grouped by `field.group`, each group's members and the groups
 * themselves both kept in the order the daemon sent them - the order
 * `LAUNCH_OPTION_FIELDS` is declared in, which already reads as a coherent
 * form. Nothing here re-sorts it.
 */
function groupFields(fields: readonly LaunchOptionField[]): [string, LaunchOptionField[]][] {
  const order: string[] = [];
  const byGroup = new Map<string, LaunchOptionField[]>();
  for (const f of fields) {
    if (!byGroup.has(f.group)) {
      byGroup.set(f.group, []);
      order.push(f.group);
    }
    byGroup.get(f.group)!.push(f);
  }
  return order.map((g) => [g, byGroup.get(g) as LaunchOptionField[]]);
}

/**
 * What a field shows on load: the effective (default + override) value the
 * daemon reported, or a type-appropriate empty value for a field neither the
 * defaults nor this world's overrides mention at all.
 */
function initialValue(field: LaunchOptionField, r: LaunchOptionsResponse): LaunchOptionValue {
  const v = r.effective[field.name];
  if (v !== undefined) return v;
  return field.type === "boolean" ? false : field.type === "int" ? 0 : "";
}

/** What Revert stages the field back to: the daemon-wide default. */
function defaultValue(field: LaunchOptionField, r: LaunchOptionsResponse): LaunchOptionValue {
  const v = r.defaults[field.name];
  if (v !== undefined) return v;
  return field.type === "boolean" ? false : field.type === "int" ? 0 : "";
}

function sameValue(field: LaunchOptionField, a: LaunchOptionValue, b: LaunchOptionValue): boolean {
  if (field.type === "int") return Number(a) === Number(b);
  return a === b;
}
