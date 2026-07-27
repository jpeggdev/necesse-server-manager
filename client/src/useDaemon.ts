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
  /** True while a server-update/mod-install/mod-update-all task is streaming over the websocket. */
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
  // Tracks in-flight task ids (server-update, mod-install, mod-update-all) so
  // the UI can block launching a second one - the HTTP route that kicks a
  // task off is fire-and-forget (it returns a taskId immediately, well before
  // the work finishes), so status.state alone does not say whether one is
  // already running.
  const [pendingTasks, setPendingTasks] = useState<Set<string>>(new Set());

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
        // A dropped connection may have swallowed a "task-done" for a task
        // that started before the drop; clearing here trades a possible
        // false "not busy" for the alternative of a stuck-forever "busy" the
        // UI could never recover from.
        setPendingTasks(new Set());
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
          setPendingTasks((prev) => (prev.has(msg.taskId) ? prev : new Set(prev).add(msg.taskId)));
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
          setPendingTasks((prev) => {
            if (!prev.has(msg.taskId)) return prev;
            const next = new Set(prev);
            next.delete(msg.taskId);
            return next;
          });
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
    busy: pendingTasks.size > 0,
    refresh,
  };
}
