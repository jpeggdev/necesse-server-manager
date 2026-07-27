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
  /** True while a mod/server task is streaming, independent of the server's own run state. */
  busy?: boolean;
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

  const stateBusy = status.state === "starting" || status.state === "stopping";
  const live = status.state === "running" || status.state === "starting";
  const canStart = !stateBusy && !live && world.trim().length > 0 && candidate?.valid !== false;

  return (
    <header className="header">
      <span className={`pill pill-${status.state}`}>{status.state}</span>

      <label htmlFor="world">World</label>
      <input
        id="world"
        list="world-options"
        value={world}
        disabled={live || stateBusy}
        onChange={(e) => setWorld(e.target.value)}
      />
      <datalist id="world-options">
        {worlds.worlds.map((w) => (
          <option key={w.name} value={w.name} />
        ))}
      </datalist>

      {candidate && candidate.name.length > 0 && (
        <span className={candidate.valid ? (candidate.exists ? "hint" : "hint hint-warn") : "hint hint-bad"}>
          {!candidate.valid
            ? "Not a valid world name"
            : candidate.exists
              ? "Will load existing world"
              : "Will create a new world"}
        </span>
      )}

      {live ? (
        <button onClick={props.onStop} disabled={status.state === "stopping"}>
          Stop
        </button>
      ) : (
        <button onClick={() => props.onStart(world)} disabled={!canStart}>
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

      {status.state === "unmanaged" && (
        <button className="danger" onClick={props.onKill} title="Risks world corruption">
          Force kill (pid {status.pid})
        </button>
      )}

      {status.lastError && <span className="hint hint-bad">{status.lastError}</span>}
    </header>
  );
}
