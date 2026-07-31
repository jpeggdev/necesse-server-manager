import { useEffect } from "react";
import type { RefObject } from "react";

/**
 * Keyboard and focus containment for a modal dialog rendered inline in the
 * app's own tree rather than in a portal - shared by `WorldSettingsDialog`
 * and `LaunchOptionsDialog`, which used to carry byte-identical copies of
 * this effect.
 *
 * Escape closes the dialog (unless `closeBlocked`, e.g. mid-save - the
 * request is already with the daemon, so closing would only hide the outcome
 * of a write still in flight). Tab is trapped inside the dialog, and anything
 * that steals focus by click or by script is pulled back in via the
 * `focusin` listener - a handler bound to the dialog itself only runs while
 * focus is already inside it, which is exactly the state that stops being
 * true the moment focus escapes.
 *
 * On mount, everything outside the dialog is marked `inert` (so background
 * controls cannot be clicked or tabbed to) and focus moves to the dialog's
 * first control; on unmount both are undone, in the order that matters: focus
 * is read out BEFORE going inert (an ancestor going inert blurs whatever it
 * was focusing), and inert is lifted BEFORE focus is restored (focus cannot
 * land on an inert element).
 */
export function useModalFocus(
  dialogRef: RefObject<HTMLElement | null>,
  backdropRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  closeBlocked: boolean,
): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (closeBlocked) return;
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      // Recomputed on every keypress rather than cached: which controls are
      // focusable changes as content loads, as Save enables, and as a save in
      // flight disables the lot.
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
  }, [dialogRef, onClose, closeBlocked]);

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const inerted = makeSurroundingsInert(backdropRef.current);
    const dialog = dialogRef.current;
    // The first control, falling back to the container while there is
    // nothing else focusable yet. Not the container itself: it is neither
    // the first focusable nor the last, so Shift+Tab from it matches no wrap
    // rule and walks straight out of the dialog.
    (dialog === null ? null : (focusableIn(dialog)[0] ?? dialog))?.focus();
    return () => {
      for (const el of inerted) el.removeAttribute("inert");
      restore?.focus();
    };
    // Deliberately mount/unmount only: re-running this on every render would
    // re-inert and re-focus on every keystroke inside the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Every element inside the dialog that can take focus right now, in tab
 * order. Read-only inputs belong here (they are focusable, and a value you
 * cannot copy out is a worse dialog); disabled ones do not.
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
 * The walk exists because the dialog renders inside the app's own tree
 * rather than in a portal, so "the rest of the page" is not one element - it
 * is the header and the body pane, then whatever sits beside their parent,
 * and so on up. Anything already inert for its own reasons is left alone.
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
