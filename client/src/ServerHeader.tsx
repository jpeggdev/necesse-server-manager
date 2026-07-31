import { useEffect, useState } from "react";
import type { StatusPayload } from "./types";
import type { WorldsResponse } from "./api";

const CANDIDATE_DEBOUNCE_MS = 300;

export interface ServerHeaderProps {
  status: StatusPayload;
  worlds: WorldsResponse;
  candidate: { name: string; valid: boolean; exists: boolean } | null;
  onStart: (world: string) => void;
  onStop: () => void;
  onKill: () => void;
  onUpdateServer: () => void;
  onCandidateChange: (name: string) => void;
  /** Opens the connection screen, to change which daemon this app talks to. */
  onEditConnection: () => void;
  /**
   * Opens the world settings editor for the name currently in the field.
   * Absent means the editor is not offered at all.
   */
  onEditWorldSettings?: (world: string) => void;
  /**
   * Opens the launch options editor for the name currently in the field.
   * Absent means the editor is not offered at all. Unlike world settings,
   * this is never blocked on the server being stopped - the daemon accepts
   * these writes while a world is running, since the game only reads its
   * launch options at the next start.
   */
  onEditLaunchOptions?: (world: string) => void;
  /** True while a mod/server task is streaming, independent of the server's own run state. */
  busy?: boolean;
  /**
   * The last stop request came back as a timeout (HTTP 504): the daemon gave
   * up waiting and deliberately left the process running. Owned by App, which
   * is the only thing that sees the response, and cleared as soon as the
   * daemon leaves `stopping`.
   */
  stopTimedOut?: boolean;
}

export function ServerHeader(props: ServerHeaderProps) {
  const { status, worlds, candidate, onCandidateChange } = props;
  const taskBusy = props.busy ?? false;
  // Prefer the world actually running (status.world) over the daemon's
  // remembered lastWorld: on first connect while a server is already up,
  // lastWorld may name a different world than the one currently loaded.
  const [world, setWorld] = useState(status.world ?? worlds.lastWorld ?? "");

  // Debounced: onCandidateChange hits the network (GET /api/worlds?name=),
  // so firing it on every keystroke would pile up requests. onCandidateChange
  // is a useCallback in App with a stable identity, so including it in the
  // dependency array does not reset the timer on unrelated re-renders.
  useEffect(() => {
    const handle = setTimeout(() => onCandidateChange(world), CANDIDATE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [world, onCandidateChange]);

  // A candidate is only trustworthy for the text currently in the box. The
  // lookup that produced `candidate` is debounced plus a network round trip
  // behind whatever the user has typed since, so `candidate` can legitimately
  // describe a name the user has already edited away from - showing its
  // verdict (or letting Start use its name) in that window is exactly the
  // "typo silently creates a world" bug this field exists to prevent.
  const candidateIsCurrent = candidate !== null && candidate.name === world;

  // `stopping` counts as live so the header keeps showing Stop (disabled)
  // while the world saves, instead of flashing a disabled Start button that
  // misreports what the server is doing.
  const live = status.state === "running" || status.state === "starting" || status.state === "stopping";

  /**
   * A stop that ran past the daemon's timeout. The daemon answers 504, leaves
   * the process alive on purpose, and stays in `stopping` - which renders a
   * disabled Stop, no Start, and (before this) no kill either, so the operator
   * who has just been told "the process was left running" had nothing at all
   * to act with short of curl. Spec 4 requires the timeout to offer a kill as
   * an explicit, separately confirmed action; this is where it becomes
   * reachable.
   *
   * Deliberately gated on the timeout having HAPPENED rather than on
   * `stopping`: an ordinary shutdown takes 2-3 seconds and is the common case,
   * and growing a force-kill button every time the server saves would train
   * the operator to reach for the one control that can corrupt the world.
   */
  const stopStalled = (props.stopTimedOut ?? false) && status.state === "stopping";
  const canStart = !live && !taskBusy && world.trim().length > 0 && candidateIsCurrent && candidate!.valid;

  /**
   * Why the world settings editor cannot be opened right now, or null when it
   * can. Three blockers, and the reason is always stated rather than left to a
   * greyed-out button:
   *
   * - Not `stopped`. The daemon refuses anything but a clean, observed stop -
   *   not stopping, not crashed, not a server it did not start - because a
   *   world zip is the only copy of that save. Saying so here rather than
   *   letting the operator find out from a 409 after filling the form in.
   * - A task in flight, same rule as every other mutation.
   * - A world that does not exist. Reusing `candidate`, which is already the
   *   one thing that knows whether a typed name names a real world, rather
   *   than adding a second source of truth that could disagree with the hint
   *   sitting right beside it.
   */
  const settingsBlockedBecause =
    status.state !== "stopped"
      ? `The server must be confirmed stopped before a world zip can be edited; it is ${status.state}`
      : taskBusy
        ? "Another task is already running"
        : world.trim().length === 0
          ? "Type the name of the world to edit"
          : !candidateIsCurrent
            ? "Waiting to confirm the world name…"
            : !candidate!.valid
              ? "Not a valid world name"
              : !candidate!.exists
                ? `There is no world named "${world}" yet`
                : null;

  /**
   * Why the launch options editor cannot be opened right now, or null when it
   * can. Deliberately missing both blockers `settingsBlockedBecause` has: the
   * daemon accepts these writes while this world is running AND while another
   * task is in flight, on purpose, because they touch one small JSON file in
   * the state directory and never the mods folder or a world zip. Blocking the
   * button on either would contradict the routes it talks to. The button stays
   * enabled through Start/Stop and through a mod install, and the dialog itself
   * is what tells the operator the change waits for the next start.
   */
  const launchOptionsBlockedBecause =
    world.trim().length === 0
      ? "Type the name of the world to edit"
      : !candidateIsCurrent
        ? "Waiting to confirm the world name…"
        : !candidate!.valid
          ? "Not a valid world name"
          : !candidate!.exists
            ? `There is no world named "${world}" yet`
            : null;

  const startTitle = taskBusy
    ? "Another task is already running"
    : world.trim().length === 0
      ? undefined
      : !candidateIsCurrent
        ? "Waiting to confirm the world name…"
        : !candidate!.valid
          ? "Not a valid world name"
          : undefined;

  return (
    <header className="header">
      <span className={`pill pill-${status.state}`}>{status.state}</span>

      <label htmlFor="world">World</label>
      <input
        id="world"
        list="world-options"
        value={world}
        disabled={live}
        onChange={(e) => setWorld(e.target.value)}
      />
      <datalist id="world-options">
        {worlds.worlds.map((w) => (
          <option key={w.name} value={w.name} />
        ))}
      </datalist>

      {world.trim().length > 0 &&
        (candidateIsCurrent ? (
          <span className={candidate!.valid ? (candidate!.exists ? "hint" : "hint hint-warn") : "hint hint-bad"}>
            {!candidate!.valid
              ? "Not a valid world name"
              : candidate!.exists
                ? "Will load existing world"
                : "Will create a new world"}
          </span>
        ) : (
          <span className="hint">Checking world name&hellip;</span>
        ))}

      {props.onEditWorldSettings !== undefined && (
        <button
          onClick={() => props.onEditWorldSettings?.(world)}
          disabled={settingsBlockedBecause !== null}
          title={settingsBlockedBecause ?? `Edit ${world}'s world settings`}
        >
          World Settings&hellip;
        </button>
      )}

      {props.onEditLaunchOptions !== undefined && (
        <button
          onClick={() => props.onEditLaunchOptions?.(world)}
          disabled={launchOptionsBlockedBecause !== null}
          title={launchOptionsBlockedBecause ?? `Edit ${world}'s launch options`}
        >
          Launch Options&hellip;
        </button>
      )}

      {live ? (
        <button onClick={props.onStop} disabled={status.state === "stopping"}>
          Stop
        </button>
      ) : (
        <button onClick={() => props.onStart(world)} disabled={!canStart} title={startTitle}>
          Start
        </button>
      )}

      <button
        onClick={props.onUpdateServer}
        disabled={live || taskBusy}
        title={
          live
            ? "Stop the server before updating it"
            : taskBusy
              ? "Another task is already running"
              : "Update the dedicated server via steamcmd"
        }
      >
        Update Server
      </button>

      {stopStalled && (
        <span className="hint hint-bad">
          Stop timed out. The server was left running deliberately and may still be saving; give it
          longer if you can.
        </span>
      )}

      {(status.state === "unmanaged" || stopStalled) && (
        <button
          className="danger"
          onClick={props.onKill}
          title={
            stopStalled
              ? "Kills the server outright, possibly mid-save. Unsaved world progress is lost and the save can be left corrupt. Only after waiting."
              : "Risks world corruption"
          }
        >
          Force kill (pid {status.pid})
        </button>
      )}

      {status.lastError && <span className="hint hint-bad">{status.lastError}</span>}

      <button
        className="settings-btn"
        onClick={props.onEditConnection}
        aria-label="Connection settings"
        title="Connection settings"
      >
        &#9881;
      </button>
    </header>
  );
}
