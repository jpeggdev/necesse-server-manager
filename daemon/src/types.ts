export type ServerState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "unmanaged"
  | "crashed";

/** What the process manager alone knows: the game server's own run state. */
export interface ServerStatus {
  state: ServerState;
  world: string | null;
  pid: number | null;
  startedAt: string | null;
  port: number | null;
  slots: number | null;
  gameVersion: string | null;
  /** Set when the server exits abnormally; cleared on the next successful start. */
  lastError: string | null;
}

/**
 * The full picture a client needs, and the single source of truth for "is
 * anything in flight." Carried identically by GET /api/status, the websocket
 * `backlog`, and every `status` broadcast.
 */
export interface StatusPayload extends ServerStatus {
  /**
   * Ids of long-running tasks (mod install, mod update-all, server update)
   * accepted by the daemon and not yet finished. Only the daemon can know
   * this: the HTTP route that accepts a task returns its id immediately and
   * the work streams over a separate websocket, so a client that tried to
   * reconstruct the set by correlating the two channels has no ordering
   * guarantee to rely on. Clients read this instead.
   */
  activeTasks: string[];
}

export interface DaemonConfig {
  port: number;
  serverRoot: string;
  javaExe: string;
  serverJar: string;
  steamcmdExe: string;
  modsDir: string;
  worldsDir: string;
  jvmArgs: string[];
  owners: string[];
  lastWorld: string | null;
  serverAppId: number;
  workshopAppId: number;
  stopTimeoutMs: number;
}

export interface ModEntry {
  id: string;
  name: string;
  jar: string;
  lastUpdated: string;
}

export interface UntrackedMod {
  jar: string;
}

export interface ModListResponse {
  managed: ModEntry[];
  untracked: UntrackedMod[];
}

export interface WorldInfo {
  name: string;
  modifiedAt: string;
  sizeBytes: number;
}

export interface ConsoleLine {
  line: string;
  ts: string;
  source: "server" | "task";
}

export type TaskKind = "mod-install" | "mod-update-all" | "server-update";

export interface InstallResult {
  id: string;
  name: string;
  jar: string | null;
  ok: boolean;
  error?: string;
  replacedJar?: string;
}

export type WsMessage =
  | { type: "backlog"; lines: ConsoleLine[]; status: StatusPayload }
  | { type: "console"; line: string; ts: string }
  | { type: "status"; status: StatusPayload }
  | { type: "task"; taskId: string; kind: TaskKind; line: string }
  | {
      type: "task-done";
      taskId: string;
      kind: TaskKind;
      ok: boolean;
      error?: string;
      results?: InstallResult[];
    };

export interface ApiError {
  ok: false;
  error: string;
}
