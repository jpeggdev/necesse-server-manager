import { useCallback, useEffect, useRef, useState } from "react";
import { ServerHeader } from "./ServerHeader";
import { ModsPanel } from "./ModsPanel";
import { PlayersPanel } from "./PlayersPanel";
import { ConsolePanel } from "./ConsolePanel";
import { ErrorBanner } from "./ErrorBanner";
import { Splitter } from "./Splitter";
import { WorldSettingsDialog } from "./WorldSettingsDialog";
import { LaunchOptionsDialog } from "./LaunchOptionsDialog";
import { sameWorld } from "./world-name";
import { ConnectionSettings } from "./ConnectionSettings";
import { useDaemon } from "./useDaemon";
import { DaemonError, STOP_TIMEOUT_STATUS, type WorldSettingValue } from "./api";
import { loadConnection, saveConnection, type Connection } from "./settings";
import type { WorldModsResponse } from "./types";
import "./App.css";

const MODS_WIDTH_KEY = "necesse.modsWidth";
const MODS_WIDTH_DEFAULT = 432;
const MODS_WIDTH_MIN = 300;
const MODS_WIDTH_MAX = 900;

/**
 * Shown on the connection screen when the app sent itself there. The daemon's
 * own 401 body is not used: it is written for whoever is holding the wrong
 * token, not for someone who has just been dropped out of a working app, and
 * this has to explain the navigation as well as the failure.
 */
export const TOKEN_REJECTED_NOTICE =
  "The daemon rejected this access token, so the app cannot stay connected. Check the token " +
  "against the one setup.cmd printed (it is in config.json on the server, under authToken), " +
  "then Connect again.";

export default function App() {
  const [conn, setConn] = useState<Connection | null>(() => loadConnection());
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const editConnection = useCallback(() => {
    setNotice(null);
    setEditing(true);
  }, []);
  const tokenRejected = useCallback(() => {
    setNotice(TOKEN_REJECTED_NOTICE);
    setEditing(true);
  }, []);

  if (conn === null || editing) {
    return (
      <main className="app">
        <ConnectionSettings
          initial={conn}
          notice={notice}
          onSave={(c) => {
            saveConnection(c);
            setConn(c);
            setEditing(false);
            setNotice(null);
          }}
          onCancel={() => {
            setEditing(false);
            setNotice(null);
          }}
        />
      </main>
    );
  }

  return (
    <ConnectedApp
      // Keyed on the whole connection, token included, so switching daemons
      // remounts the whole tree rather than leaving one daemon's worlds and
      // console on screen under another daemon's status. Host/port alone would
      // miss a token-only edit - the single most likely correction a user makes
      // on this screen - and refresh()/readLibrary() have no request-generation
      // guard, so a stale response from the old daemon could still land and
      // populate state under the new one.
      key={`${conn.host}:${conn.port}:${conn.token}`}
      conn={conn}
      onEditConnection={editConnection}
      onTokenRejected={tokenRejected}
    />
  );
}

function ConnectedApp({
  conn,
  onEditConnection,
  onTokenRejected,
}: {
  conn: Connection;
  onEditConnection: () => void;
  /**
   * Separate from onEditConnection because the two arrive at the same screen
   * for opposite reasons, and only one of them owes the user an explanation.
   * Not one callback taking a reason: ServerHeader wires its button straight to
   * onEditConnection, so a click would pass its MouseEvent as the reason.
   */
  onTokenRejected: () => void;
}) {
  const {
    api,
    status,
    worlds,
    mods,
    library,
    libraryError,
    modUpdates,
    updatesError,
    console: lines,
    players,
    connected,
    error: daemonError,
    busy: taskBusy,
    refresh,
    unauthorized,
  } = useDaemon(conn);
  // A rejected token is the one connection failure the user can only fix here.
  useEffect(() => {
    if (unauthorized) onTokenRejected();
  }, [unauthorized, onTokenRejected]);
  const [leftTab, setLeftTab] = useState<"mods" | "players">("mods");
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
  // The world whose settings dialog is open, or null for closed. The name
  // comes from the header's own field, so the dialog always edits the world
  // the header's candidate check just verified exists.
  const [settingsWorld, setSettingsWorld] = useState<string | null>(null);
  // The world whose launch options dialog is open, or null for closed. Kept
  // separate from settingsWorld: the two dialogs can be opened independently,
  // and unlike world settings this one is not blocked on the server being
  // stopped, so it must not share that dialog's lifecycle.
  const [launchOptionsWorld, setLaunchOptionsWorld] = useState<string | null>(null);

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

  // Neither goes through guard(): the dialog owns the whole load/change/save
  // exchange, so its failures belong in the dialog beside the form that caused
  // them rather than in the app-wide banner behind it. Stable identities
  // because the dialog loads on mount off `load`.
  const loadWorldSettings = useCallback((w: string) => api.worldSettings(w), [api]);
  const saveWorldSettings = useCallback(
    (w: string, changes: Record<string, WorldSettingValue>) => api.saveWorldSettings(w, changes),
    [api],
  );

  // Read-only, so it does not go through guard(): a search must not touch the
  // error banner or fire a refresh(), and it stays usable while the server is
  // running. Only the Install button a result carries is gated.
  const searchWorkshop = useCallback(
    (q: string, cursor?: string) => api.workshopSearch(q, cursor),
    [api],
  );

  /**
   * The world whose mod set the panel shows: the name in the header's field,
   * but only once the daemon has answered about it.
   *
   * Taken from `candidate` rather than from a second copy of the field, and
   * that is the whole reason it is not a third piece of state: `candidate` is
   * already the debounced, sequence-guarded answer the header draws its own
   * verdict from, so the checkboxes and the "Will load existing world" hint
   * can never end up describing two different worlds. An invalid name has no
   * set to show, and asking for one would only earn a 400.
   */
  const modSetWorld = candidate !== null && candidate.valid ? candidate.name : null;
  const [worldMods, setWorldMods] = useState<WorldModsResponse | null>(null);
  // Tagged with the world it is about. Both this and the payload above are held
  // across a world change, and the panel discards whichever does not name the
  // world it is rendering - an untagged message would slip past that check and
  // report one world's failure under another's name.
  const [worldModsError, setWorldModsError] = useState<
    { world: string; message: string } | null
  >(null);
  const worldModsSeq = useRef(0);

  // Re-read on every library change as well as every world change: an install,
  // an upload or an `Update All` can be what makes a set's missing mod stop
  // being missing, and the panel says a world will not start on the strength of
  // that list.
  useEffect(() => {
    const seq = ++worldModsSeq.current;
    // Not asked for at all when the library could not be read: a daemon that
    // has no /api/mods/library has no /api/worlds/:name/mods either, and a
    // second 404 says nothing the first one has not already said.
    if (modSetWorld === null || libraryError !== null) {
      setWorldMods(null);
      setWorldModsError(null);
      return;
    }
    api
      .worldMods(modSetWorld)
      .then((r) => {
        if (seq !== worldModsSeq.current) return;
        setWorldMods(r);
        setWorldModsError(null);
      })
      .catch((e: Error) => {
        // Deliberately not the app-wide banner: one panel's read failing is not
        // the daemon being unreachable, and the message belongs beside the list
        // it could not fill in.
        if (seq !== worldModsSeq.current) return;
        setWorldMods(null);
        setWorldModsError({ world: modSetWorld, message: e.message });
      });
  }, [api, modSetWorld, library, libraryError]);

  /**
   * Writes the set the panel has ticked.
   *
   * Not through guard(): the panel owns the whole read/tick/save exchange, so
   * the daemon's refusal - which names the ids it has no jar for - belongs
   * beside the checkboxes that caused it rather than in the banner behind them.
   * The refresh is still fired, because a set change is what the next start
   * reads.
   */
  const saveWorldModSet = useCallback(
    async (modIds: string[]) => {
      if (modSetWorld === null) throw new Error("No world is selected.");
      const written = await api.saveWorldMods(modSetWorld, modIds);
      // Bumped before the write lands so a read still in flight from before it
      // cannot overwrite the result with what the set used to be.
      worldModsSeq.current += 1;
      setWorldMods(written);
      setWorldModsError(null);
      await refresh();
      return written;
    },
    [api, modSetWorld, refresh],
  );

  /**
   * Sends a picked jar's bytes to the daemon, which validates its `mod.info`
   * before it stores anything. Read here rather than in the panel so the panel
   * never touches the transport, and refreshed on success because the library
   * it just grew is what the checkboxes above are drawn from.
   */
  const uploadMod = useCallback(
    async (file: File) => {
      const written = await api.uploadMod(await file.arrayBuffer(), file.name);
      await refresh();
      return written;
    },
    [api, refresh],
  );

  // The library is deliberately NOT part of this gate. It is the one read that
  // a daemon running an older build cannot answer, and holding the whole app -
  // status, console, Stop - behind it would make an ordinary version skew look
  // like an unreachable daemon while somebody is playing.
  if (!connected || !status || !worlds || !mods) {
    return (
      <main className="app">
        <ErrorBanner error={error} onDismiss={() => setError(null)} />
        <p className="connecting">
          Connecting to the daemon at {conn.host}:{conn.port}&hellip;
        </p>
      </main>
    );
  }

  const running = status.state === "running" || status.state === "starting";
  const busy = taskBusy || submitting > 0;

  return (
    <main className="app">
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {status.configWarnings.map((w, i) => (
        // Index, not the text: two warnings can legitimately say the same
        // thing (e.g. steamcmd missing, reported the same way after every
        // reconnect), and a duplicate string as the key would collide.
        <p key={i} className="hint hint-warn config-warning">
          {w}
        </p>
      ))}
      <ServerHeader
        status={status}
        worlds={worlds}
        candidate={candidate}
        busy={busy}
        stopTimedOut={stopTimedOut}
        onCandidateChange={onCandidateChange}
        onEditConnection={onEditConnection}
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
        onEditWorldSettings={(w) => setSettingsWorld(w)}
        onEditLaunchOptions={(w) => setLaunchOptionsWorld(w)}
      />
      <div className="body">
        <div className="mods-pane" style={{ width: modsWidth }}>
          <div className="pane-tabs" role="tablist" aria-label="Left panel">
            <button
              role="tab"
              aria-selected={leftTab === "mods"}
              onClick={() => setLeftTab("mods")}
            >
              Mods
            </button>
            <button
              role="tab"
              aria-selected={leftTab === "players"}
              onClick={() => setLeftTab("players")}
            >
              Players ({players.length})
            </button>
          </div>
          {/* Hidden rather than unmounted: the mods panel holds a workshop
              search, an in-progress mod set and upload state, none of which
              should be thrown away by looking at who is online. */}
          <div className="pane-body" hidden={leftTab !== "players"}>
            <PlayersPanel
              players={players}
              running={running}
              onRefresh={guard(async () => {
                const r = await api.refreshPlayers();
                // Answers ok:false rather than throwing when there is no server
                // to ask, so the refusal has to be surfaced explicitly.
                if (!r.ok) setError(r.error ?? "Could not ask the server who is online.");
              })}
            />
          </div>
          <div className="pane-body" hidden={leftTab !== "mods"}>
          <ModsPanel
            mods={mods}
            library={library ?? []}
            libraryError={libraryError}
            updates={modUpdates}
            updatesError={updatesError}
            busy={busy}
            running={running}
            world={modSetWorld}
            worldMods={worldMods}
            worldModsError={worldModsError}
            // Not offered at all when the library is unreadable: both write
            // through it, so a Save or an Upload could only fail, and the panel
            // already says why they are gone.
            onSaveSet={libraryError === null ? saveWorldModSet : undefined}
            onUpload={libraryError === null ? uploadMod : undefined}
            onSearch={searchWorkshop}
            onAdd={(id, name) => guard(() => api.addMod(id, name))()}
            onRemove={(id) => guard(() => api.removeMod(id))()}
            onUpdateAll={guard(() => api.updateAllMods())}
          />
          </div>
        </div>
        <Splitter
          width={modsWidth}
          min={MODS_WIDTH_MIN}
          max={MODS_WIDTH_MAX}
          onResize={resizeMods}
        />
        <ConsolePanel lines={lines} />
      </div>
      {settingsWorld !== null && (
        <WorldSettingsDialog
          // A fresh mount per world, so no state can outlive the world it
          // describes. The dialog checks the name on its own response too, but
          // this is the structural half: nothing here has to reason about what
          // a changed prop would do to fields, drafts and a save in flight
          // against a world zip, because it cannot happen.
          key={settingsWorld}
          world={settingsWorld}
          load={loadWorldSettings}
          save={saveWorldSettings}
          onClose={() => setSettingsWorld(null)}
          // A write changes the zip's mtime, which the world list shows.
          onSaved={() => void refresh()}
        />
      )}
      {launchOptionsWorld !== null && (
        <LaunchOptionsDialog
          key={launchOptionsWorld}
          world={launchOptionsWorld}
          api={api}
          // `running` alone misses `starting`, where the process is already
          // spawned with its command line - a save made then still has to
          // wait for the NEXT start, same as `running`. And `status.world`
          // has to be compared with `sameWorld`, not `===`: world lookup is
          // case-insensitive everywhere else in this client, and the header's
          // free-text box is exactly where a case-only retype would slip past
          // a strict comparison and silently suppress the notice.
          serverRunningThisWorld={
            (status.state === "running" || status.state === "starting") &&
            status.world !== null &&
            sameWorld(status.world, launchOptionsWorld)
          }
          onClose={() => setLaunchOptionsWorld(null)}
        />
      )}
    </main>
  );
}
