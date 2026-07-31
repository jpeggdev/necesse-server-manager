import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Api } from "./api";
import { sameWorld } from "./world-name";
import type { LaunchOptionField, LaunchOptionsResponse, LaunchOptionValue } from "./types";

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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (saving) return;
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = focusableIn(dialog);
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const dialog = dialogRef.current;
      if (dialog === null || dialog.contains(e.target as Node | null)) return;
      (focusableIn(dialog)[0] ?? dialog).focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [onClose, saving]);

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const inerted = makeSurroundingsInert(backdropRef.current);
    const dialog = dialogRef.current;
    (dialog === null ? null : (focusableIn(dialog)[0] ?? dialog))?.focus();
    return () => {
      for (const el of inerted) el.removeAttribute("inert");
      restore?.focus();
    };
  }, []);

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
      const initial = initialValue(f, loaded);
      const current = draft[f.name];
      if (current === undefined || sameValue(f, initial, current)) continue;
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
    api
      .saveLaunchOptions(world, changes)
      .then((r) => {
        adopt(r);
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
                      overridden={
                        !cleared.has(f.name) &&
                        Object.prototype.hasOwnProperty.call(loaded.overrides, f.name)
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
              {changedNames.length === 0
                ? "Nothing had changed, so nothing was written."
                : `Saved ${changedNames.join(", ")}.`}
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
  /** Not overridden for this world (or staged to become that way on save). */
  inherited: boolean;
  /** Overridden right now, so a Revert control is offered. */
  overridden: boolean;
  disabled: boolean;
  onChange: (value: LaunchOptionValue) => void;
  onRevert: () => void;
}

function FieldRow({ field, value, inherited, overridden, disabled, onChange, onRevert }: FieldRowProps) {
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
            Overridden for {"this world"}.{" "}
            {overridden && (
              <button type="button" onClick={onRevert} disabled={disabled}>
                Revert {field.label} to default
              </button>
            )}
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
          value={typeof value === "number" ? value : Number(value)}
          min={field.min}
          max={field.max}
          step={1}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
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

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
    ),
  ];
}

function makeSurroundingsInert(from: HTMLElement | null): Element[] {
  const marked: Element[] = [];
  let node: HTMLElement | null = from;
  while (node !== null && node !== document.body) {
    const parent: HTMLElement | null = node.parentElement;
    if (parent === null) break;
    for (const sibling of parent.children) {
      if (sibling !== node && !sibling.hasAttribute("inert")) {
        sibling.setAttribute("inert", "");
        marked.push(sibling);
      }
    }
    node = parent;
  }
  return marked;
}
