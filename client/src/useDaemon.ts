import { useCallback, useEffect, useMemo, useState } from "react";
import { baseUrl, wsUrl, type Connection } from "./settings";
import { DaemonError, UNAUTHORIZED_STATUS, makeApi, type Api, type WorldsResponse } from "./api";
import type {
  ModLibraryEntry,
  ModListResponse,
  ModUpdateInfo,
  StatusPayload,
  WsMessage,
} from "./types";

const CONSOLE_LIMIT = 2000;
const WS_RETRY_MS = 2000;

/**
 * Consecutive failed websocket connection attempts before the UI stops
 * presenting the situation as "still connecting" and says something is wrong.
 * Three at the 2s retry is ~6 seconds, which is long enough to ride out a
 * daemon restart or a flapping link without crying wolf, and short enough that
 * nobody sits watching a spinner that is never going to resolve.
 */
export const WS_FAILURE_THRESHOLD = 3;

export interface ConsoleEntry {
  line: string;
  ts: string;
  kind: "server" | "task";
}

export interface DaemonState {
  api: Api;
  status: StatusPayload | null;
  worlds: WorldsResponse | null;
  lastWorld: string | null;
  mods: ModListResponse | null;
  /**
   * Every mod the daemon holds a jar for, or null before the first read and
   * after a failed one.
   *
   * Read on refresh()'s schedule - an install, an `Update All` and an upload all
   * write it - but NOT inside its Promise.all, and that is the whole point. This
   * is the newest endpoint in the API, so it is the one a daemon that has not
   * been updated yet does not have; folded in, its 404 rejects the status, the
   * world list and the mod list along with it, and the app sits on "Connecting
   * to the daemon" with no console and no Stop button while people are playing.
   * Same rule as GET /api/mods/updates: a second read, its own error, and a
   * failure that costs only the features that need it.
   */
  library: ModLibraryEntry[] | null;
  /** Why the library could not be read. Never routed into `error`, for the reason above. */
  libraryError: string | null;
  /**
   * Per-mod workshop update status, or null when it is unknown - which is the
   * state before the first check lands AND the state after a failed one. Null
   * means "show no badges", never "nothing is out of date".
   */
  modUpdates: ModUpdateInfo[] | null;
  /**
   * Why the update check has nothing to say, when it failed. Deliberately not
   * routed into `error`: `error` is the daemon-connectivity banner, and Steam
   * being unreachable is not the daemon being unreachable. Conflating them
   * would put a red banner over a perfectly working app.
   */
  updatesError: string | null;
  console: ConsoleEntry[];
  connected: boolean;
  error: string | null;
  /**
   * True while the daemon reports at least one long-running task in flight.
   *
   * Read straight off the status payload rather than reconstructed here. The
   * daemon accepts a task over HTTP and streams it over a separate websocket,
   * with no ordering guarantee between the two, so any attempt to correlate
   * "the response carried this taskId" against "task-done arrived for it"
   * races: a fast-failing task's task-done can land before its own HTTP
   * response does. The daemon already knows the truth; it publishes it in
   * every status payload (GET /api/status, the websocket backlog, and a
   * status broadcast whenever the set changes), so a reconnect re-syncs by
   * construction instead of needing recovery logic.
   */
  busy: boolean;
  refresh: () => Promise<void>;
  /**
   * The daemon rejected this token. Terminal, unlike every other failure: the
   * socket retries every 2s, and against a bad token that spins forever behind
   * a "connecting" message that will never resolve and never explain itself.
   * The app returns to the settings screen instead.
   */
  unauthorized: boolean;
}

export function useDaemon(conn: Connection): DaemonState {
  const base = baseUrl(conn);
  const socketUrl = wsUrl(conn);
  // useMemo, not a lazy useState initializer: base and token have to move
  // together with socketUrl when the connection changes, or HTTP calls would
  // keep hitting the old daemon with the old token while the socket reopens
  // at the new address. Keyed on the two primitives that actually determine
  // the request target, not on `conn` itself - `conn` is a fresh object every
  // render (App.tsx re-derives it), and memoizing on its identity would
  // rebuild `api` on every render for no reason.
  const api = useMemo<Api>(() => makeApi(base, conn.token), [base, conn.token]);
  const [unauthorized, setUnauthorized] = useState(false);
  // A token edited from the settings screen deserves a fresh attempt, not a
  // lockout that outlives the correction until the app restarts.
  useEffect(() => {
    setUnauthorized(false);
  }, [base, conn.token]);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [worlds, setWorlds] = useState<WorldsResponse | null>(null);
  const [mods, setMods] = useState<ModListResponse | null>(null);
  const [library, setLibrary] = useState<ModLibraryEntry[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [modUpdates, setModUpdates] = useState<ModUpdateInfo[] | null>(null);
  const [updatesError, setUpdatesError] = useState<string | null>(null);
  const [lines, setLines] = useState<ConsoleEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The mod library, read on its own so that it can fail on its own.
   *
   * Deliberately outside refresh()'s Promise.all - see `library` on DaemonState.
   * The message names what stopped working and what did not, because the bare
   * status line a 404 produces ("404 Not Found") tells the operator neither
   * which route answered it nor that the rest of the app is fine.
   */
  const readLibrary = useCallback(async () => {
    try {
      const r = await api.modLibrary();
      setLibrary(r.mods);
      setLibraryError(null);
    } catch (e) {
      if (e instanceof DaemonError && e.status === UNAUTHORIZED_STATUS) setUnauthorized(true);
      // Dropped rather than kept: a stale library would offer ticks for mods
      // whose jars this daemon may no longer have.
      setLibrary(null);
      setLibraryError(
        `The mod library could not be read (${(e as Error).message}). Per-world mod sets, ` +
          `the library list and jar upload are unavailable until it can be; everything else ` +
          `here still works. A daemon older than this feature has no /api/mods/library and ` +
          `answers 404.`,
      );
    }
  }, [api]);

  const refresh = useCallback(async () => {
    // Fired alongside, never awaited into the group below: its rejection is
    // handled inside itself, so it cannot take the other three reads down.
    void readLibrary();
    try {
      const [s, w, m] = await Promise.all([api.status(), api.worlds(), api.mods()]);
      setStatus(s);
      setWorlds(w);
      setMods(m);
      setError(null);
    } catch (e) {
      if (e instanceof DaemonError && e.status === UNAUTHORIZED_STATUS) setUnauthorized(true);
      // Surface the daemon's/fetch's own message verbatim rather than
      // swallowing it - the operator needs to see why the UI went stale.
      setError((e as Error).message);
    }
  }, [api, readLibrary]);

  /**
   * Identity of the managed set as far as update-checking is concerned: which
   * ids are installed and when each was installed. Both halves matter - an
   * install that replaces a jar changes only `lastUpdated`, and that is exactly
   * the event that should clear the badge it was prompted by.
   */
  const modsKey =
    mods === null ? "" : mods.managed.map((m) => `${m.id}@${m.lastUpdated}`).join(",");

  /**
   * The update check runs in its own effect rather than inside refresh(), and
   * that separation is the point: refresh() is a Promise.all whose rejection
   * blanks the whole UI, so a Steam outage folded into it would take the mod
   * list, the world list and the status down with it. Here a failure sets
   * `updatesError` and leaves every other piece of state untouched.
   *
   * Keyed on `modsKey` so it fires exactly when the managed set actually
   * changes - not on every status broadcast, and not on every console line.
   */
  useEffect(() => {
    if (modsKey.length === 0) {
      setModUpdates(null);
      setUpdatesError(null);
      return;
    }
    let cancelled = false;
    api
      .modUpdates()
      .then((r) => {
        if (cancelled) return;
        setModUpdates(r.mods);
        setUpdatesError(null);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        // Dropped, not kept: stale badges after a failed re-check would claim
        // an update is available for a mod that may have just been updated.
        setModUpdates(null);
        setUpdatesError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, modsKey]);

  const append = useCallback((entry: ConsoleEntry) => {
    setLines((prev) => {
      const next = [...prev, entry];
      // Cap keeps the NEWEST lines: slice off the front, not the back.
      return next.length > CONSOLE_LIMIT ? next.slice(next.length - CONSOLE_LIMIT) : next;
    });
  }, []);

  /**
   * Why a run of failed connections is worth an HTTP round trip: the two
   * failures behind it need completely different actions from the operator,
   * and spec 9 requires the client to tell them apart. If HTTP answers, the
   * daemon is up and something in between is eating the WebSocket upgrade (a
   * proxy, a firewall rule, antivirus TLS inspection) - the app will keep
   * working for one-shot requests but will never show live console or status.
   * If HTTP fails too, the daemon is simply not reachable, and fetch's own
   * message says how. Either way the operator learns something; before this,
   * both rendered as "Connecting to the daemon..." forever.
   */
  const diagnoseConnectFailure = useCallback(
    async (attempts: number) => {
      try {
        await api.status();
        setError(
          `The daemon at ${base} answers over HTTP, but the live update socket at ` +
            `${socketUrl} could not be opened after ${attempts} attempts. Console output and status ` +
            `changes cannot arrive until it connects - check for a firewall or proxy blocking the ` +
            `WebSocket upgrade.`,
        );
      } catch (e) {
        if (e instanceof DaemonError && e.status === UNAUTHORIZED_STATUS) setUnauthorized(true);
        setError((e as Error).message);
      }
    },
    [api, base, socketUrl],
  );

  useEffect(() => {
    // A rejected token is not a transient failure, and retrying it forever
    // would bury the one message that tells the user what to fix.
    if (unauthorized) return;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    // Consecutive failures since the last successful open. Reset in onopen, so
    // a socket that keeps opening and dropping (a daemon being restarted)
    // never trips the threshold - only a run of attempts that never connect.
    let failures = 0;

    const connect = () => {
      ws = new WebSocket(socketUrl);
      ws.onopen = () => {
        failures = 0;
        setConnected(true);
        void refresh();
      };
      ws.onclose = () => {
        // An unmount closes the socket itself; that is not a failed attempt.
        if (closed) return;
        setConnected(false);
        failures += 1;
        if (failures >= WS_FAILURE_THRESHOLD) void diagnoseConnectFailure(failures);
        // Nothing task-related to unwind here: the reconnect's backlog (and
        // refresh()) carries the daemon's current activeTasks, so whatever
        // happened during the outage is resolved by re-reading the truth
        // rather than by guessing at it.
        retry = setTimeout(connect, WS_RETRY_MS);
      };
      ws.onerror = () => {
        // onclose always follows onerror for a WebSocket, so both the retry
        // and the failure counting stay solely in onclose - this only avoids
        // an unhandled "error" event surfacing as an uncaught exception.
      };
      ws.onmessage = (ev) => {
        let msg: WsMessage;
        try {
          msg = JSON.parse(ev.data as string) as WsMessage;
        } catch {
          // A malformed frame must not kill the handler for future messages.
          console.error("Received malformed WebSocket frame from daemon:", ev.data);
          return;
        }
        if (msg.type === "backlog") {
          setStatus(msg.status);
          setLines(msg.lines.map((l) => ({ line: l.line, ts: l.ts, kind: l.source })));
        } else if (msg.type === "console") {
          append({ line: msg.line, ts: msg.ts, kind: "server" });
        } else if (msg.type === "status") {
          setStatus(msg.status);
        } else if (msg.type === "task") {
          append({ line: msg.line, ts: new Date().toISOString(), kind: "task" });
        } else if (msg.type === "task-done") {
          const summary = msg.ok ? `--- ${msg.kind} finished` : `--- ${msg.kind} FAILED: ${msg.error ?? ""}`;
          append({ line: summary, ts: new Date().toISOString(), kind: "task" });
          for (const r of msg.results ?? []) {
            // Update All skips a mod whose workshop entry has not changed, and
            // this line is the only place that is reported. Reusing "ok -> jar"
            // for it would make a run that downloaded nothing read exactly like
            // one that reinstalled everything. The jar is still named: it is
            // what the world loads either way. Failure wins over skipped, so a
            // result carrying both cannot lose its error to the quiet line.
            const outcome = !r.ok
              ? `FAILED: ${r.error ?? ""}`
              : r.skipped
                ? `unchanged, kept ${r.jar}`
                : `ok -> ${r.jar}`;
            append({
              line: `    ${r.name} (${r.id}): ${outcome}`,
              ts: new Date().toISOString(),
              kind: "task",
            });
          }
          // The daemon also broadcasts a status carrying the shrunken
          // activeTasks; this pulls the mod/world lists the task just changed.
          void refresh();
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, [append, refresh, diagnoseConnectFailure, socketUrl, unauthorized]);

  return {
    api,
    status,
    worlds,
    lastWorld: worlds?.lastWorld ?? null,
    mods,
    library,
    libraryError,
    modUpdates,
    updatesError,
    console: lines,
    connected,
    error,
    // The `?.` on a field the type declares as required guards exactly one
    // real case: a daemon still running an older build, whose status payload
    // predates activeTasks. Reading false there is a degraded UI; reading
    // `.length` off undefined is a TypeError during render, i.e. a white
    // screen with no way to see what went wrong.
    busy: (status?.activeTasks?.length ?? 0) > 0,
    refresh,
    unauthorized,
  };
}
