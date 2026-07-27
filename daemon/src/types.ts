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
  /**
   * A short plain-text blurb, NOT the workshop description verbatim. Steam
   * returns thousands of characters of BBCode per item; `steam-workshop.ts`
   * strips the markup and truncates to DESCRIPTION_LIMIT before this leaves the
   * daemon, so no caller ever has to defend against the full payload. Empty
   * when Steam sent no description at all.
   */
  description: string;
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
  /**
   * The workshop thumbnail, or "" when Steam has no usable entry. Carried here
   * rather than fetched separately because this route already holds the full
   * WorkshopItem: the client gets mod-list thumbnails for no extra Steam
   * traffic at all, and a Steam outage costs them along with the badges.
   */
  previewUrl: string;
  /** The same truncated blurb as WorkshopItem.description; "" when unknown. */
  description: string;
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

export type WorldSettingType = "boolean" | "int" | "float" | "enum" | "string";

/**
 * One line of a world's `worldSettings.cfg`, as GET /api/worlds/:name/settings
 * reports it.
 *
 * `value` is the raw text exactly as the file spells it, not a parsed value.
 * The file is the authority and it is edited textually so that keys this daemon
 * does not know - the `rpgskills*` ones a mod writes - survive an edit
 * untouched; reporting the raw text keeps the API honest about that. `type`
 * tells a client how to read it, and is null precisely for those unknown keys.
 *
 * `options`, `min` and `max` travel with the field so a form never hardcodes an
 * option set. They come from `Server.jar`, and a client's guess at them would
 * be a guess about what the game accepts.
 */
export interface WorldSettingField {
  key: string;
  value: string;
  /** null for a key written by a mod: unknown type, unknown legal values. */
  type: WorldSettingType | null;
  /** Enum fields only. */
  options?: string[];
  /** Numeric fields only, inclusive. */
  min?: number;
  max?: number;
  /** false for unknown keys and for fields the game owns, such as gameVersion. */
  editable: boolean;
}

export interface WorldSettingsResponse {
  ok: true;
  world: string;
  /** The zip entry these came from, e.g. "Tulsa What/worldSettings.cfg". */
  entry: string;
  /** In the order the file declares them, unknown keys included. */
  fields: WorldSettingField[];
}

export interface WorldSettingsWriteResponse extends WorldSettingsResponse {
  /**
   * Where the pre-edit zip was copied, or null when nothing was written
   * because every requested value already matched the file.
   */
  backup: string | null;
  /** Keys whose line actually changed. A no-op edit changes nothing at all. */
  changed: string[];
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
