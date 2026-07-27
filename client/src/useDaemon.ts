import { useCallback, useEffect, useState } from "react";
import { makeApi, type Api, type WorldsResponse } from "./api";
import type { ModListResponse, StatusPayload, WsMessage } from "./types";

export const DAEMON_BASE = "http://192.168.1.106:8710";
const WS_URL = "ws://192.168.1.106:8710/ws";
const CONSOLE_LIMIT = 2000;
// Bounds the "already completed" bookkeeping below (see TaskState) so a
// long session can't grow it forever even in the one case nothing else
// consumes an entry: a task-launching fetch that never resolves at all
// (dropped mid-flight) after the daemon already ran the task to completion.
const COMPLETED_TASK_CAP = 50;

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
  /**
   * Marks a taskId as pending the instant its launching HTTP response
   * arrives - addMod/updateAllMods/updateServer resolve with {ok:true,
   * taskId} well before the daemon's first websocket "task" line for it, so
   * relying solely on that first line leaves `busy` false for the whole
   * window steamcmd/the installer is already running. Call this from the
   * `.then()` of those three calls.
   *
   * The HTTP response and the websocket are independent channels with no
   * ordering guarantee: for a fast-failing task, "task-done" can arrive
   * BEFORE this is called. If registerTask blindly added the id in that
   * case, nothing would ever clear it (the daemon sends exactly one
   * task-done per id) and `busy` would read true for the rest of the
   * session. So a task-done that arrives for an unregistered id is
   * remembered as "already completed"; registerTask checks that set first
   * and refuses to (re)add an id that's already done, instead consuming the
   * marker - see TaskState below.
   */
  registerTask: (taskId: string) => void;
  refresh: () => Promise<void>;
}

/**
 * `pending`: task ids currently in flight (busy = pending.size > 0).
 * `completed`: task ids whose "task-done" arrived before registerTask() was
 * called for them - a marker so the later, out-of-order registerTask call
 * can be suppressed instead of adding an id nothing will ever clear. Each
 * entry is removed the moment it does its job (registerTask sees it and
 * refuses to add), so it only lingers if the matching HTTP response never
 * arrives at all; COMPLETED_TASK_CAP bounds that residual case.
 */
interface TaskState {
  pending: Set<string>;
  completed: Set<string>;
}

const EMPTY_TASK_STATE: TaskState = { pending: new Set(), completed: new Set() };

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
  // already running. See TaskState above for why `completed` exists too.
  const [taskState, setTaskState] = useState<TaskState>(EMPTY_TASK_STATE);

  const registerTask = useCallback((taskId: string) => {
    setTaskState((prev) => {
      if (prev.completed.has(taskId)) {
        // task-done already arrived for this id before this call did.
        // Refuse to add it to pending (nothing would ever clear it), and
        // consume the marker - it has now served its purpose.
        const completed = new Set(prev.completed);
        completed.delete(taskId);
        return { pending: prev.pending, completed };
      }
      if (prev.pending.has(taskId)) return prev;
      const pending = new Set(prev.pending);
      pending.add(taskId);
      return { pending, completed: prev.completed };
    });
  }, []);

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
        // UI could never recover from. The completed-marker set is reset
        // too - a reconnect gets a fresh backlog/status, so a marker from
        // before the drop no longer refers to anything the UI still cares
        // about suppressing.
        setTaskState(EMPTY_TASK_STATE);
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
          // Usually a no-op: registerTask() already marked this taskId
          // pending from the HTTP response before the first line could
          // possibly arrive. Kept as a fallback for any future task kind
          // that isn't registered synchronously from a response.
          registerTask(msg.taskId);
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
          setTaskState((prev) => {
            if (prev.pending.has(msg.taskId)) {
              // Normal order: registerTask already ran; this is the real
              // completion.
              const pending = new Set(prev.pending);
              pending.delete(msg.taskId);
              return { pending, completed: prev.completed };
            }
            if (prev.completed.has(msg.taskId)) return prev; // duplicate/unknown - harmless no-op
            // Race: task-done beat the HTTP response that will call
            // registerTask for this id. Remember it so that later call is
            // suppressed instead of adding an id nothing will ever clear.
            const completed = new Set(prev.completed);
            completed.add(msg.taskId);
            if (completed.size > COMPLETED_TASK_CAP) {
              const oldest = completed.values().next().value;
              if (oldest !== undefined) completed.delete(oldest);
            }
            return { pending: prev.pending, completed };
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
  }, [append, refresh, registerTask]);

  return {
    api,
    status,
    worlds,
    lastWorld: worlds?.lastWorld ?? null,
    mods,
    console: lines,
    connected,
    error,
    busy: taskState.pending.size > 0,
    registerTask,
    refresh,
  };
}
