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
    registerTask,
    refresh,
  } = useDaemon();
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<{ name: string; valid: boolean; exists: boolean } | null>(null);
  // Local in-flight counter closes the gap between "the fetch that kicks a
  // non-task action (start/stop/kill) off has resolved" and its refresh()
  // landing - purely a click-spam guard for those, since they carry no
  // taskId to track. Task-launching actions (addMod/updateAllMods/
  // updateServer) are NOT covered by this: their real "busy" span is closed
  // deterministically below via registerTask(), not by this counter.
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

  // For addMod/updateAllMods/updateServer specifically: these resolve with
  // {ok:true, taskId} the moment the daemon ACCEPTS the task, long before
  // steamcmd/the installer actually finishes (or even emits its first
  // console line). Registering the taskId here - on the resolved response,
  // not on the first websocket "task" line - is what closes the window a
  // reviewer found open: without it, `busy` read false for the whole span
  // between "HTTP call returned" and "steamcmd wrote its first log line",
  // during which Start would incorrectly re-enable. A rejected call (bad
  // input, server not stopped, network failure) never reaches `.then()`, so
  // a failed launch cannot register a phantom pending task.
  const guardTask = useCallback(
    (fn: () => Promise<{ ok: true; taskId: string }>) => () => {
      setSubmitting((n) => n + 1);
      fn()
        .then((r) => {
          registerTask(r.taskId);
          setError(null);
          return refresh();
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setSubmitting((n) => n - 1));
    },
    [refresh, registerTask],
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
        onUpdateServer={guardTask(() => api.updateServer())}
      />
      <div className="body">
        <ModsPanel
          mods={mods}
          busy={busy}
          running={running}
          onAdd={(id, name) => guardTask(() => api.addMod(id, name))()}
          onRemove={(id) => guard(() => api.removeMod(id))()}
          onUpdateAll={guardTask(() => api.updateAllMods())}
        />
        <ConsolePanel lines={lines} />
      </div>
    </main>
  );
}
