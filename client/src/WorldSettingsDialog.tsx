import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorldSettingValue } from "./api";
import { sameWorld } from "./world-name";
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
  const backdropRef = useRef<HTMLDivElement>(null);

  const adopt = useCallback((next: WorldSettingField[]) => {
    setFields(next);
    setDraft(Object.fromEntries(next.map((f) => [f.key, f.value])));
  }, []);

  useEffect(() => {
    let cancelled = false;
    /*
     * Everything this component holds is one world's, so a change of world
     * drops all of it before the next one is read.
     *
     * App mounts this fresh per world (`key={settingsWorld}`), so today the
     * effect only ever runs once - but that is the caller's guarantee, not this
     * component's, and what it would cost to lose is not a stale label: the
     * previous world's fields and half-typed drafts would render under the new
     * world's name and `save(world, changes)` would write that diff into the new
     * world's zip, which is the only copy of somebody's save. It defends itself.
     */
    setFields(null);
    setDraft({});
    setLoadError(null);
    setSaveError(null);
    setResult(null);
    load(world)
      .then((r) => {
        if (cancelled) return;
        // The response names the world it describes. Trusting the request we
        // think we made instead would adopt an answer about another world in
        // exactly the case this is here for.
        if (!sameWorld(r.world, world)) return;
        adopt(r.fields);
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

  /**
   * Keyboard and focus containment, declared BEFORE the effect that restores
   * focus so that on unmount these listeners are gone before that one moves
   * focus back - otherwise the focusin guard below would drag focus back into
   * a dialog that is being removed.
   *
   * Both listeners are on the document, not on the dialog element. A handler
   * bound to the dialog only runs while focus is already inside it, which is
   * exactly the state that stops being true the moment focus escapes: once it
   * is out, nothing on the dialog is in the event path any more and it can
   * never pull it back. Shift+Tab from the element focus opens on used to walk
   * straight out to the page behind, which made `aria-modal` a claim this
   * component did not honour.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape cancels - but not mid-save. The request is already with the
      // daemon, so closing would only hide the outcome of a write that is
      // still happening to a world zip.
      if (e.key === "Escape") {
        if (saving) return;
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      // Recomputed on every keypress rather than cached: which controls are
      // focusable changes as the fields load, as Save enables, and as a save
      // in flight disables the lot.
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
    // Focus can also be taken by a click or by script, not only by Tab.
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

  /**
   * Focus into the dialog on open, back to whatever opened it on close, and
   * the rest of the page made `inert` in between - a second defence that does
   * not depend on a key handler seeing the event, and which also stops the
   * header's Start/Stop and the mod panel being clicked while a modal is up.
   *
   * The order inside matters both ways round. The element to restore to is
   * read BEFORE the background goes inert, because a browser blurs whatever it
   * was focusing when an ancestor becomes inert, and inert is lifted BEFORE
   * focus is handed back, because focus cannot land on an inert element.
   */
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const inerted = makeSurroundingsInert(backdropRef.current);
    const dialog = dialogRef.current;
    // The first control, falling back to the container while the fields are
    // still loading and there is nothing else yet. Not the container itself:
    // it is neither the first focusable nor the last, so Shift+Tab from it
    // matches no wrap rule and walks straight out of the dialog.
    (dialog === null ? null : (focusableIn(dialog)[0] ?? dialog))?.focus();
    return () => {
      for (const el of inerted) el.removeAttribute("inert");
      restore?.focus();
    };
  }, []);

  /**
   * Number boxes the USER has emptied. An `input[type=number]` reports an empty
   * string both for a box that was cleared and for one typed nonsense into, and
   * an empty string is NOT a value: `Number("")` is 0, so treating it as one
   * would send 0 for a field the user probably meant to leave alone. On
   * `maxSettlersPerSettlement` or `droppedItemsLifeMinutes`, whose stored -1
   * means "no limit", that 0 is in range, the daemon accepts it, and somebody's
   * world silently goes from unlimited to none.
   *
   * `!storedIsUnreadable` is what keeps this from punishing the operator for
   * their own file. `value` is the file's raw text and `type` comes from the
   * key name, so a line a mod or an old hand-edit left as
   * `maxSettlersPerSettlement = ` arrives as an int holding "". Blocking on
   * that would disable Save for the whole dialog on open, over a field nobody
   * touched - and the only way out would be typing a number into it, which
   * writes a value the operator never chose. The escape hatch would be worse
   * than the bug. A box can only block the save if it HAD a readable number and
   * no longer does, which is exactly the case where the user emptied it.
   */
  const blockedKeys = useMemo(
    () =>
      (fields ?? [])
        .filter(
          (f) =>
            f.editable && isBlankNumber(f, draft[f.key] ?? f.value) && !storedIsUnreadable(f),
        )
        .map((f) => f.key),
    [fields, draft],
  );

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
      // A blank number box contributes nothing at all - not the old value,
      // which the box no longer shows, and certainly not a made-up one. This
      // covers the file's own unreadable lines too: they are left untouched
      // rather than "corrected" into whatever Number() makes of them.
      if (isBlankNumber(f, text)) continue;
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

  return (
    // No click-to-dismiss on the backdrop: a stray click next to a form of
    // unsaved edits should not discard them. Escape and Cancel are the ways out.
    <div className="modal-backdrop" ref={backdropRef}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="world-settings-title"
        tabIndex={-1}
        ref={dialogRef}
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
                  blocking={blockedKeys.includes(f.key)}
                  onChange={(v) => {
                    // Drop the previous save's outcome the moment editing
                    // resumes. Leaving "Saved difficulty" on screen beside a
                    // freshly edited box reads as though the new edit is
                    // already written too.
                    setResult(null);
                    setSaveError(null);
                    setDraft((d) => ({ ...d, [f.key]: v }));
                  }}
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
          {/* "Cancel" is a lie once a write has landed - there is nothing left
              to abandon, and the word invites the reader to think closing might
              undo it. */}
          <button onClick={onClose} disabled={saving}>
            {result === null ? "Cancel" : "Close"}
          </button>
          <button
            onClick={onSave}
            disabled={saving || fields === null || blockedKeys.length > 0 || changedKeys.length === 0}
            title={
              saving
                ? "Saving…"
                : blockedKeys.length > 0
                  ? `Left empty: ${blockedKeys.join(", ")}. An empty box is not a value - type a number, or restore the stored one.`
                  : changedKeys.length === 0
                    ? // After a write, "nothing has been changed yet" reads as a
                      // contradiction of the success line directly above it.
                      result !== null
                      ? "Already saved. Change a value to save again."
                      : "Nothing has been changed yet"
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
  /** The user emptied a box that held a readable number, so the save is blocked on it. */
  blocking: boolean;
  onChange: (value: string) => void;
}

function FieldRow({ field, text, disabled, blocking, onChange }: FieldRowProps) {
  const id = `ws-${field.key}`;
  // A numeric line the FILE itself leaves blank or unreadable, still showing
  // exactly what the file has. Distinct from `blocking` in both directions:
  // this one never blocks a save, and it must never be worded as though the
  // user had emptied something or could put something back.
  const unreadableInFile = storedIsUnreadable(field) && isBlankNumber(field, text);
  return (
    <div className={field.type === null ? "ws-row ws-row-mod" : "ws-row"}>
      <label htmlFor={id}>{field.key}</label>
      {renderControl(field, id, text, disabled, blocking, onChange)}
      {blocking ? (
        <p className="hint hint-bad ws-note">
          Left empty, so there is nothing to save for it. Type a number, or put back the stored{" "}
          {field.value}.
        </p>
      ) : unreadableInFile ? (
        <p className="hint hint-warn ws-note">
          This world&apos;s file has no readable number here (
          {field.value.trim().length === 0 ? "the line is empty" : `it says "${field.value}"`}). It
          is left exactly as it is unless you type a number, and a number you type is a new value
          rather than a restored one.
        </p>
      ) : (
        fieldNote(field) !== null && <p className="hint ws-note">{fieldNote(field)}</p>
      )}
    </div>
  );
}

function renderControl(
  field: WorldSettingField,
  id: string,
  text: string,
  disabled: boolean,
  blocking: boolean,
  onChange: (value: string) => void,
) {
  // `editable` is the daemon's verdict and the only thing that decides this.
  // It covers both things this form must never write: a key a mod owns
  // (nothing here knows its legal values) and gameVersion, which the game
  // writes to record the build that last saved the world. Shown either way, so
  // nobody is surprised by what is in their file, and never as an input that
  // accepts typing. The TYPE below only picks which control to draw - keeping
  // the two separate means an editable field of a new type renders as an
  // editable control rather than silently as a read-only one.
  if (!field.editable) {
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
          // Only when the user emptied it. A line the file itself left
          // unreadable is not the operator's error to be flagged for.
          aria-invalid={blocking}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "string":
    case null:
      // Only reachable if the daemon ever reports an editable field of a type
      // with no richer control than a text box. Plain text is the honest
      // rendering; the daemon still validates whatever is typed.
      return (
        <input id={id} type="text" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      );
  }
}

function fieldNote(field: WorldSettingField): string | null {
  if (!field.editable) {
    return field.type === null
      ? "Written by a mod. Shown so you can see it is there; it is preserved exactly and cannot be changed here."
      : "Written by the game and never changed here.";
  }
  // The bounds are the daemon's, which is what will enforce them - including
  // the max of 10 on the day/night modifiers, which the file documents in its
  // own comment. Showing anything else here would be a second, wrong copy.
  if (field.min !== undefined && field.max !== undefined) return `Allowed range ${field.min} to ${field.max}`;
  if (field.min !== undefined) return `At least ${field.min}`;
  if (field.max !== undefined) return `At most ${field.max}`;
  return null;
}

/**
 * Whether a numeric field's box currently holds no number at all.
 *
 * This is the whole of the empty-box problem, and it is not a theoretical one:
 * `Number("")` is 0, and an `input[type=number]` reports "" both for a cleared
 * box and for anything unparseable typed into it. So the drafted text has to be
 * inspected as TEXT. A caller that only asked `Number.isFinite(Number(text))`
 * would be told an empty box holds zero.
 */
function isBlankNumber(field: WorldSettingField, text: string): boolean {
  if (field.type !== "int" && field.type !== "float") return false;
  const trimmed = text.trim();
  return trimmed.length === 0 || !Number.isFinite(Number(trimmed));
}

/**
 * Whether the FILE's own text for a numeric field is not a number.
 *
 * `value` is raw file text and `type` is looked up by key name, so the daemon
 * will report `maxSettlersPerSettlement = ` as an int whose value is "". That
 * is a pre-existing state of somebody's world, not something the operator did,
 * and the editor's job is to leave it alone and say so - never to block the
 * dialog over it, and never to invite the user to "restore" a value that was
 * never there.
 */
function storedIsUnreadable(field: WorldSettingField): boolean {
  return isBlankNumber(field, field.value);
}

/**
 * Every element inside the dialog that can take focus right now, in tab order.
 * Read-only inputs belong here (they are focusable, and a value you cannot copy
 * out is a worse dialog); disabled ones do not.
 */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
    ),
  ];
}

/**
 * Marks everything that is not the dialog `inert`, by walking up from it and
 * inerting each level's other children. Returns what it touched so the same
 * set, and only that set, is released again.
 *
 * The walk exists because the dialog renders inside the app's own tree rather
 * than in a portal, so "the rest of the page" is not one element - it is the
 * header and the body pane, then whatever sits beside their parent, and so on
 * up. Anything already inert for its own reasons is left alone.
 */
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
 * The drafted text as JSON of the type the daemon expects for that field.
 *
 * Only ever called for text that `isBlankNumber` has already cleared, which is
 * what makes the `Number(text)` here safe: on an empty box it would return 0,
 * a value the daemon accepts and would happily write. Whether a box holds a
 * number is decided before this point, not here.
 */
function toWire(field: WorldSettingField, text: string): WorldSettingValue {
  if (field.type === "boolean") return text === "true";
  if (field.type === "int" || field.type === "float") return Number(text);
  return text;
}
