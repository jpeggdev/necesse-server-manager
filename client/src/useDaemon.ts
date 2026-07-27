import { useCallback, useEffect, useState } from "react";
import { makeApi, type Api, type WorldsResponse } from "./api";
import type { ModListResponse, StatusPayload, WsMessage } from "./types";

export const DAEMON_BASE = "http://192.168.1.106:8710";
const WS_URL = "ws://192.168.1.106:8710/ws";
const CONSOLE_LIMIT = 2000;

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
}

export function useDaemon(): DaemonState {
  // Lazy useState initializer (not useRef(makeApi(...)).current) so makeApi
  // runs exactly once - a ref initializer argument is still evaluated (and
  // discarded) on every render.
  const [api] = useState<Api>(() => makeApi(DAEMON_BASE));
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [worlds, setWorlds] = useState<WorldsResponse | null>(null);
  const [mods, setMods] = useState<ModListResponse | null>(null);
  const [lines, setLines] = useState<ConsoleEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, w, m] = await Promise.all([api.status(), api.worlds(), api.mods()]);
      setStatus(s);
      setWorlds(w);
      setMods(m);
      setError(null);
    } catch (e) {
      // Surface the daemon's/fetch's own message verbatim rather than
      // swallowing it - the operator needs to see why the UI went stale.
      setError((e as Error).message);
    }
  }, [api]);

  const append = useCallback((entry: ConsoleEntry) => {
    setLines((prev) => {
      const next = [...prev, entry];
      // Cap keeps the NEWEST lines: slice off the front, not the back.
      return next.length > CONSOLE_LIMIT ? next.slice(next.length - CONSOLE_LIMIT) : next;
    });
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => {
        setConnected(true);
        void refresh();
      };
      ws.onclose = () => {
        setConnected(false);
        // Nothing task-related to unwind here: the reconnect's backlog (and
        // refresh()) carries the daemon's current activeTasks, so whatever
        // happened during the outage is resolved by re-reading the truth
        // rather than by guessing at it.
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => {
        // onclose always follows onerror for a WebSocket, so reconnection
        // scheduling stays solely in onclose - this only avoids an unhandled
        // "error" event from surfacing as an uncaught exception.
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
            append({
              line: `    ${r.name} (${r.id}): ${r.ok ? `ok -> ${r.jar}` : `FAILED: ${r.error ?? ""}`}`,
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
  }, [append, refresh]);

  return {
    api,
    status,
    worlds,
    lastWorld: worlds?.lastWorld ?? null,
    mods,
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
  };
}
