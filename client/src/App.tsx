import { useCallback, useEffect, useRef, useState } from "react";
import { ServerHeader } from "./ServerHeader";
import { ModsPanel } from "./ModsPanel";
import { ConsolePanel } from "./ConsolePanel";
import { ErrorBanner } from "./ErrorBanner";
import { Splitter } from "./Splitter";
import { useDaemon } from "./useDaemon";
import { DaemonError, STOP_TIMEOUT_STATUS } from "./api";
import "./App.css";

const MODS_WIDTH_KEY = "necesse.modsWidth";
const MODS_WIDTH_DEFAULT = 432;
const MODS_WIDTH_MIN = 300;
const MODS_WIDTH_MAX = 900;

export default function App() {
  const {
    api,
    status,
    worlds,
    mods,
    modUpdates,
    updatesError,
    console: lines,
    connected,
    error: daemonError,
    busy: taskBusy,
    refresh,
  } = useDaemon();
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<{ name: string; valid: boolean; exists: boolean } | null>(null);
  // Covers the click-to-response span only: from the moment a mutation is
  // clicked until its HTTP call and the follow-up refresh() have landed.
  // Everything after that is `taskBusy`, which comes from the daemon's own
  // activeTasks - and since the daemon adds a task to that set before it
  // answers the request that launched it, the refresh() inside this window
  // already sees it. The two spans overlap; they never leave a gap.
  const [submitting, setSubmitting] = useState(0);
  // Set only by a 504 from POST /api/server/stop - the daemon waited out
  // stopTimeoutMs, gave up, and left the process running on purpose. It is the
  // one failure that leaves the header with no usable control, so it is what
  // unlocks Force kill.
  const [stopTimedOut, setStopTimedOut] = useState(false);

  const [modsWidth, setModsWidth] = useState(() => {
    const saved = Number(localStorage.getItem(MODS_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : MODS_WIDTH_DEFAULT;
  });
  const resizeMods = useCallback((w: number) => {
    setModsWidth(w);
    localStorage.setItem(MODS_WIDTH_KEY, String(w));
  }, []);

  // Cleared the moment the daemon leaves `stopping`, however it got there: the
  // server finally finished saving, the kill landed, or a new run started. A
  // force-kill button that outlived the stuck stop it belongs to would be
  // pointing at a different process than the one the operator saw hang.
  const serverState = status?.state;
  useEffect(() => {
    if (serverState !== "stopping") setStopTimedOut(false);
  }, [serverState]);

  // The daemon-connectivity error (from useDaemon's own refresh() failures)
  // and mutation errors (from guard()'s catch) are two different sources
  // feeding one dismissible banner. Copy a new daemon error into the local,
  // dismissible copy whenever it changes; useDaemon's own `error` field has
  // no setter, so it can't be dismissed directly.
  useEffect(() => {
    if (daemonError) setError(daemonError);
  }, [daemonError]);

  const guard = useCallback(
    (fn: () => Promise<unknown>, onFailure?: (e: Error) => void) => () => {
      setSubmitting((n) => n + 1);
      fn()
        .then(() => {
          setError(null);
          return refresh();
        })
        .catch((e: Error) => {
          setError(e.message);
          onFailure?.(e);
        })
        .finally(() => setSubmitting((n) => n - 1));
    },
    [refresh],
  );

  // Guards against out-of-order responses: if the user types quickly enough
  // that two /api/worlds?name= requests are in flight at once, only the
  // response to the MOST RECENT request may update `candidate` - otherwise a
  // slow earlier keystroke's response could land after a later one and show
  // stale validity for whatever the user has since typed.
  const candidateSeq = useRef(0);
  const onCandidateChange = useCallback(
    (name: string) => {
      const seq = ++candidateSeq.current;
      if (name.trim().length === 0) {
        setCandidate(null);
        return;
      }
      api
        .worlds(name)
        .then((r) => {
          if (seq === candidateSeq.current) setCandidate(r.candidate);
        })
        .catch(() => {
          if (seq === candidateSeq.current) setCandidate(null);
        });
    },
    [api],
  );

  // Read-only, so it does not go through guard(): a search must not touch the
  // error banner or fire a refresh(), and it stays usable while the server is
  // running. Only the Install button a result carries is gated.
  const searchWorkshop = useCallback(
    (q: string, cursor?: string) => api.workshopSearch(q, cursor),
    [api],
  );

  if (!connected || !status || !worlds || !mods) {
    return (
      <main className="app">
        <ErrorBanner error={error} onDismiss={() => setError(null)} />
        <p className="connecting">Connecting to the daemon at 192.168.1.106:8710&hellip;</p>
      </main>
    );
  }

  const running = status.state === "running" || status.state === "starting";
  const busy = taskBusy || submitting > 0;

  return (
    <main className="app">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      <ServerHeader
        status={status}
        worlds={worlds}
        candidate={candidate}
        busy={busy}
        stopTimedOut={stopTimedOut}
        onCandidateChange={onCandidateChange}
        onStart={(w) => guard(() => api.start(w))()}
        onStop={guard(
          () => api.stop(),
          // The status, not the message text: the daemon owns its wording and
          // may reword the timeout at any point without meaning to change what
          // the UI offers.
          (e) => {
            if (e instanceof DaemonError && e.status === STOP_TIMEOUT_STATUS) setStopTimedOut(true);
          },
        )}
        onKill={guard(() => api.kill())}
        onUpdateServer={guard(() => api.updateServer())}
      />
      <div className="body">
        <div className="mods-pane" style={{ width: modsWidth }}>
          <ModsPanel
            mods={mods}
            updates={modUpdates}
            updatesError={updatesError}
            busy={busy}
            running={running}
            onSearch={searchWorkshop}
            onAdd={(id, name) => guard(() => api.addMod(id, name))()}
            onRemove={(id) => guard(() => api.removeMod(id))()}
            onUpdateAll={guard(() => api.updateAllMods())}
          />
        </div>
        <Splitter
          width={modsWidth}
          min={MODS_WIDTH_MIN}
          max={MODS_WIDTH_MAX}
          onResize={resizeMods}
        />
        <ConsolePanel lines={lines} />
      </div>
    </main>
  );
}
