import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { WorldSettingValue } from "./api";
import type {
  WorldSettingField,
  WorldSettingsResponse,
  WorldSettingsWriteResponse,
} from "./types";

export interface WorldSettingsDialogProps {
  world: string;
  /** GET /api/worlds/:name/settings. Must be stable across renders. */
  load: (world: string) => Promise<WorldSettingsResponse>;
  /** PUT /api/worlds/:name/settings, with only the changed keys. Must be stable. */
  save: (
    world: string,
    changes: Record<string, WorldSettingValue>,
  ) => Promise<WorldSettingsWriteResponse>;
  onClose: () => void;
  /** Fired only when a save actually rewrote the zip, so a stale world list can be pulled again. */
  onSaved?: () => void;
}

/**
 * A modal editor for one world's `worldSettings.cfg`.
 *
 * Modal, rather than a third view in the mods panel, because this is a rare
 * transactional edit - load, change, save - that the daemon only permits with
 * the server confirmed stopped, so there is nothing else worth doing at the
 * same time. It also streams nothing to the console, so covering the console
 * costs the operator no visibility, and world settings are not mods: a third
 * toggle beside the panel's Search/Back pair would crowd it and say the wrong
 * thing about what these are.
 *
 * Every control here is built from what the DAEMON reported for that field -
 * its type, its option set, its bounds. None of it is duplicated in this file.
 * The daemon read the enum option sets out of `Server.jar`; a client-side copy
 * would be a guess about what the game accepts, and offering a value the game
 * rejects is how a save gets corrupted.
 */
export function WorldSettingsDialog({
  world,
  load,
  save,
  onClose,
  onSaved,
}: WorldSettingsDialogProps) {
  const [fields, setFields] = useState<WorldSettingField[] | null>(null);
  /** Raw text per key, mirroring how the file itself stores every value. */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<WorldSettingsWriteResponse | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);

  const adopt = useCallback((next: WorldSettingField[]) => {
    setFields(next);
    setDraft(Object.fromEntries(next.map((f) => [f.key, f.value])));
  }, []);

  useEffect(() => {
    let cancelled = false;
    load(world)
      .then((r) => {
        if (!cancelled) adopt(r.fields);
      })
      .catch((e: Error) => {
        // The daemon's own text: a missing zip, a zip with no settings entry
        // and an unreadable one are different problems with different fixes,
        // and only its message says which happened.
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [load, world, adopt]);

  // Focus moves into the dialog on open and back to whatever opened it on
  // close. The container itself takes it rather than the first control,
  // because the fields do not exist yet while the load is in flight.
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => restore?.focus();
  }, []);

  // Escape cancels - but not mid-save. The request is already with the daemon
  // at that point, so closing would only hide the outcome of a write that is
  // still happening to a world zip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || saving) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  /**
   * Exactly the fields whose value differs from the file's, in the JSON shape
   * the daemon validates. A save that sent every field would rewrite lines the
   * user never touched, and the daemon has no way to tell the difference.
   *
   * Numbers compare numerically, so a field read as `1.0` and handed back as
   * `1` is not a change. The daemon collapses that case too, but a request
   * that never claims the change is the honest one.
   */
  const changes = useMemo(() => {
    const out: Record<string, WorldSettingValue> = {};
    for (const f of fields ?? []) {
      if (!f.editable) continue;
      const text = draft[f.key] ?? f.value;
      if (isSameAsFile(f, text)) continue;
      out[f.key] = toWire(f, text);
    }
    return out;
  }, [fields, draft]);

  const changedKeys = Object.keys(changes);

  const onSave = () => {
    setSaving(true);
    setSaveError(null);
    setResult(null);
    save(world, changes)
      .then((r) => {
        setResult(r);
        // The response carries the file as it now stands, so the form rebases
        // on it: a second save from the same open dialog then sends only what
        // changed since this one.
        adopt(r.fields);
        if (r.backup !== null) onSaved?.();
      })
      .catch((e: Error) => setSaveError(e.message))
      .finally(() => setSaving(false));
  };

  // aria-modal claims focus is confined to the dialog, so it is.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), select:not(:disabled), input:not([disabled])",
    );
    if (focusable === undefined || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    // No click-to-dismiss on the backdrop: a stray click next to a form of
    // unsaved edits should not discard them. Escape and Cancel are the ways out.
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="world-settings-title"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h2 id="world-settings-title">World settings &mdash; {world}</h2>
          <button onClick={onClose} disabled={saving} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="modal-body">
          <p className="hint">
            Saving copies the world zip to a timestamped backup first, then rewrites it in place.
            Only the fields you change are written; every other line, including the ones mods
            wrote, is left exactly as it is.
          </p>

          {loadError !== null && <p className="hint hint-bad">{loadError}</p>}

          {fields === null && loadError === null && <p className="hint">Reading the world&hellip;</p>}

          {fields !== null && (
            <div className="ws-fields">
              {fields.map((f) => (
                <FieldRow
                  key={f.key}
                  field={f}
                  text={draft[f.key] ?? f.value}
                  disabled={saving}
                  onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                />
              ))}
            </div>
          )}

          {saveError !== null && <p className="hint hint-bad">{saveError}</p>}

          {result !== null && (
            <p className={result.backup === null ? "hint" : "hint hint-ok"}>
              {result.backup === null
                ? "Every value already matched the file, so nothing was written and no backup was needed."
                : `Saved ${result.changed.join(", ")}. Backup written to ${result.backup}`}
            </p>
          )}
        </div>

        <div className="modal-foot">
          <button onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={saving || fields === null || changedKeys.length === 0}
            title={
              saving
                ? "Saving…"
                : changedKeys.length === 0
                  ? "Nothing has been changed yet"
                  : `Writes ${changedKeys.join(", ")}`
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
  field: WorldSettingField;
  text: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

function FieldRow({ field, text, disabled, onChange }: FieldRowProps) {
  const id = `ws-${field.key}`;
  const note = fieldNote(field);
  return (
    <div className={field.type === null ? "ws-row ws-row-mod" : "ws-row"}>
      <label htmlFor={id}>{field.key}</label>
      {renderControl(field, id, text, disabled, onChange)}
      {note !== null && <p className="hint ws-note">{note}</p>}
    </div>
  );
}

function renderControl(
  field: WorldSettingField,
  id: string,
  text: string,
  disabled: boolean,
  onChange: (value: string) => void,
) {
  // `editable` is the daemon's verdict, and it covers both things this form
  // must never write: a key a mod owns (type null - nothing here knows its
  // legal values) and gameVersion, which the game writes to record the build
  // that last saved the world. Shown either way, so nobody is surprised by
  // what is in their file, and never as an input that accepts typing.
  if (!field.editable || field.type === null || field.type === "string") {
    return <input id={id} className="ws-readonly" value={text} readOnly aria-readonly="true" />;
  }
  switch (field.type) {
    case "boolean":
      return (
        <input
          id={id}
          type="checkbox"
          checked={text === "true"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
        />
      );
    case "enum": {
      const options = field.options ?? [];
      // A value the reported option set does not contain is kept as an option
      // of its own rather than dropped. A select that cannot show its current
      // value silently displays the first one instead, which would turn simply
      // opening the dialog into an unintended change to that field.
      const shown = options.includes(text) ? options : [text, ...options];
      return (
        <select id={id} value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {shown.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    case "int":
    case "float":
      return (
        <input
          id={id}
          type="number"
          value={text}
          min={field.min}
          max={field.max}
          step={field.type === "int" ? 1 : "any"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function fieldNote(field: WorldSettingField): string | null {
  if (field.type === null) {
    return "Written by a mod. Shown so you can see it is there; it is preserved exactly and cannot be changed here.";
  }
  if (!field.editable) {
    return "Written by the game and never changed here.";
  }
  // The bounds are the daemon's, which is what will enforce them - including
  // the max of 10 on the day/night modifiers, which the file documents in its
  // own comment. Showing anything else here would be a second, wrong copy.
  if (field.min !== undefined && field.max !== undefined) return `Allowed range ${field.min} to ${field.max}`;
  if (field.min !== undefined) return `At least ${field.min}`;
  if (field.max !== undefined) return `At most ${field.max}`;
  return null;
}

/** Whether the drafted text would leave this field's line as the file already has it. */
function isSameAsFile(field: WorldSettingField, text: string): boolean {
  if (field.type === "int" || field.type === "float") {
    const a = Number(field.value);
    const b = Number(text);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  return field.value === text;
}

/**
 * The drafted text as JSON of the type the daemon expects for that field. A
 * number box that has been emptied or typed into becomes NaN here, which
 * serialises as null and comes back as the daemon's own "must be a whole
 * number, not null" - the authority on what is acceptable stays in one place.
 */
function toWire(field: WorldSettingField, text: string): WorldSettingValue {
  if (field.type === "boolean") return text === "true";
  if (field.type === "int" || field.type === "float") return Number(text);
  return text;
}
