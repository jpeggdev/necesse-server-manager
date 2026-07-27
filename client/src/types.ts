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
  /**
   * Steam Web API key, needed only by workshop search. Empty means "not
   * configured", which is the shipped default: everything else the daemon asks
   * Steam for works anonymously. Hand-edited in config.json on the server
   * itself and never returned over the API - see PublicDaemonConfig.
   */
  steamApiKey: string;
}

/**
 * What GET /api/config actually returns. The API has no authentication by
 * deliberate design, so every field it emits is readable by anything on the
 * LAN; the Steam key is therefore replaced by a boolean rather than redacted
 * in place, so there is no shape in which the key could survive the trip.
 * Clients only ever need to know whether search is available.
 */
export type PublicDaemonConfig = Omit<DaemonConfig, "steamApiKey"> & {
  steamApiKeyConfigured: boolean;
};

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

/**
 * One usable Steam Workshop entry, flattened from whichever Steam endpoint
 * produced it. `updatedAt` is Steam's `time_updated` (unix seconds) as ISO, or
 * null when Steam sent none - never the epoch, so "unknown" cannot read as
 * "1970".
 *
 * Entries Steam reports a non-1 `result` for, and entries flagged `banned`,
 * never become a WorkshopItem: neither can be downloaded, so there is no
 * `banned` field here because a banned item is simply absent. Visibility is
 * not filtered - an unlisted item still installs by id.
 */
export interface WorkshopItem {
  id: string;
  title: string;
  previewUrl: string;
  updatedAt: string | null;
  fileSize: number;
  subscriptions: number;
}

export interface WorkshopSearchResponse {
  ok: true;
  items: WorkshopItem[];
  /** Feed back as ?cursor= for the next page. null when there are no more. */
  nextCursor: string | null;
  total: number;
}

/**
 * One managed mod's update status, from GET /api/mods/updates.
 *
 * `updateAvailable` compares the workshop entry's `time_updated` against when
 * this daemon last installed the mod. Steam moves that timestamp for ANY edit
 * to the workshop entry - a retitle, a description tweak, a new screenshot -
 * so a true here means "the entry changed after we installed it", which is an
 * indication an update may exist, not proof of a new jar.
 */
export interface ModUpdateInfo {
  id: string;
  /** The workshop title when Steam knew the item, else the registry's name. */
  title: string;
  workshopUpdatedAt: string | null;
  /** ModEntry.lastUpdated: when this daemon last installed it. */
  installedAt: string;
  /**
   * false when Steam returned no usable entry: a non-1 result (removed, bad
   * id), or an entry flagged banned. Such a mod keeps working locally; Steam
   * simply has nothing to compare against, so it never shows an update.
   */
  onWorkshop: boolean;
  updateAvailable: boolean;
}

export interface ModUpdatesResponse {
  ok: true;
  checkedAt: string;
  mods: ModUpdateInfo[];
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
