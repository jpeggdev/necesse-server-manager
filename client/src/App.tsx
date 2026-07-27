import { useCallback, useEffect, useRef, useState } from "react";
import { ServerHeader } from "./ServerHeader";
import { ModsPanel } from "./ModsPanel";
import { ConsolePanel } from "./ConsolePanel";
import { ErrorBanner } from "./ErrorBanner";
import { useDaemon } from "./useDaemon";
import "./App.css";

export default function App() {
  const {
    api,
    status,
    worlds,
    mods,
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

  // The daemon-connectivity error (from useDaemon's own refresh() failures)
  // and mutation errors (from guard()'s catch) are two different sources
  // feeding one dismissible banner. Copy a new daemon error into the local,
  // dismissible copy whenever it changes; useDaemon's own `error` field has
  // no setter, so it can't be dismissed directly.
  useEffect(() => {
    if (daemonError) setError(daemonError);
  }, [daemonError]);

  const guard = useCallback(
    (fn: () => Promise<unknown>) => () => {
      setSubmitting((n) => n + 1);
      fn()
        .then(() => {
          setError(null);
          return refresh();
        })
        .catch((e: Error) => setError(e.message))
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
        onCandidateChange={onCandidateChange}
        onStart={(w) => guard(() => api.start(w))()}
        onStop={guard(() => api.stop())}
        onKill={guard(() => api.kill())}
        onUpdateServer={guard(() => api.updateServer())}
      />
      <div className="body">
        <ModsPanel
          mods={mods}
          busy={busy}
          running={running}
          onAdd={(id, name) => guard(() => api.addMod(id, name))()}
          onRemove={(id) => guard(() => api.removeMod(id))()}
          onUpdateAll={guard(() => api.updateAllMods())}
        />
        <ConsolePanel lines={lines} />
      </div>
    </main>
  );
}
