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
  /**
   * The game's own data directory, passed to the server as `-datadir`.
   *
   * Without it the server derives this folder from the *running account's*
   * `APPDATA`, which makes the whole install a property of whoever launched it.
   * That is what pinned the daemon to an interactive `jeffp` logon: run as
   * SYSTEM it would resolve
   * `C:\Windows\system32\config\systemprofile\AppData\Roaming\Necesse` and come
   * up with zero worlds and zero mods, having failed at nothing it could report.
   * Naming it explicitly makes the identity of the process irrelevant, which is
   * what lets the scheduled task run AtStartup as SYSTEM.
   *
   * `modsDir` and `worldsDir` are the daemon's own view of the same tree and
   * must be `<dataDir>\mods` and `<dataDir>\saves\worlds`; see
   * `dataDirConflict`, which refuses to boot if they disagree.
   */
  dataDir: string;
  /**
   * Where the daemon reads and writes mod jars. Absolute, and the same folder
   * the game will load from - it must equal `<dataDir>\mods`.
   */
  modsDir: string;
  /**
   * Where the daemon reads world zips. Absolute, and the same folder the game
   * will save to - it must equal `<dataDir>\saves\worlds`.
   */
  worldsDir: string;
  /**
   * Where the mod library keeps its jars, one subfolder per mod id, and where
   * its manifest and the per-world sets are written.
   *
   * Deliberately under the daemon's own directory and never under `serverRoot`:
   * that tree is steamcmd-managed (it holds `steamapps/appmanifest_1169370.acf`)
   * and this daemon's own server update runs `app_update ... validate`, which
   * reconciles it against Steam's manifest. Anything of ours in there is an
   * unknown file a validate pass may prune - and the library is the only copy of
   * a hand-placed or uploaded jar.
   */
  modLibraryDir: string;
  modLibraryFile: string;
  modSetsFile: string;
  /**
   * Largest jar POST /api/mods/upload will accept, in bytes. Real mods run to a
   * few megabytes; the limit exists so an unauthenticated LAN endpoint cannot be
   * used to fill the disk, not to be tight.
   */
  modUploadMaxBytes: number;
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

/**
 * What a jar's own `mod.info` says about it.
 *
 * `id` is the identity everything in the mod library and the per-world sets is
 * keyed by. It is what the game records in `modlist.data`, it survives a
 * version bump that renames the jar, and it is identical whether the jar came
 * from the workshop or from an upload. The remaining fields are descriptive:
 * they are recorded and shown, and nothing is decided by them - `gameVersion`
 * in particular is surfaced but never enforced, because the game itself is what
 * decides whether a mod loads.
 */
export interface ModInfo {
  id: string;
  /** `name` from the file, or the id when the file gives none. Never empty. */
  name: string;
  version: string;
  gameVersion: string;
  author: string;
  clientside: boolean;
}

/**
 * Where a library jar came from.
 *
 * A workshop mod carries its published-file id, so `Update All` knows what to
 * re-download. A local one has no such id and never will - `upload` arrived
 * through the API, `adopted` was found sitting in the mods folder and taken into
 * the library so that reconcile could safely remove it from there.
 */
export type ModSource =
  | { kind: "workshop"; workshopId: string }
  | { kind: "local"; how: "upload" | "adopted" };

/** One jar file the library holds, current or superseded. */
export interface ModLibraryJar {
  /**
   * The filename it arrived under, and the name the mods folder receives. This
   * is what the game logs and what a person recognises, so it is kept intact
   * even when two builds of one mod ship under it.
   */
  jar: string;
  /**
   * Its name on disk inside the library. Equal to `jar` except when a second
   * build arrived under a filename already taken by different bytes, where it
   * carries a hash suffix so neither overwrites the other. The disambiguation
   * lives here, in the library's own storage, and never reaches the mods folder.
   *
   * Optional because a manifest written before storage names were split out of
   * `jar` does not carry it, and those manifests are on disk on the live server
   * right now - the daemon's own directory is never rewritten by a deploy. For
   * them the two names were always the same string, so every reader falls back
   * to `jar`. Declaring it required would make the type describe a file that
   * does not exist yet rather than the ones that do.
   */
  file?: string;
  /** SHA-256 of the jar's bytes. What "the library already holds this" means. */
  sha256: string;
  sizeBytes: number;
  /** When it was put into the library, ISO 8601. */
  addedAt: string;
  source: ModSource;
}

/**
 * One mod the library knows about, with exactly one *current* jar per `id` -
 * the one reconcile installs - and every earlier jar retained beside it.
 *
 * The jars live at `<modLibraryDir>/<safe mod id>/<file>`: a per-id subfolder,
 * so the original filename survives (it is what the game logs, and what a person
 * recognises) while two mods that happen to ship the same jar name still cannot
 * collide. The storage name is `file`, not `jar`, because two builds of one mod
 * routinely arrive under one filename and only one of them could be written
 * there; `jar` stays the name the mods folder receives.
 *
 * `superseded` is not history for its own sake. The library is the only copy of
 * a hand-placed or uploaded jar, and reconcile deletes from the mods folder on
 * the strength of the library holding those bytes - so a newer jar arriving must
 * never overwrite an older one, or the older one is gone for good. Disk is
 * cheap; an unrecoverable jar is not.
 */
export interface ModLibraryEntry extends ModInfo {
  /** The current jar's filename: the name reconcile gives it in the mods folder. */
  jar: string;
  /**
   * The current jar's name on disk inside the library, absent in a manifest
   * written before the two names were split. See ModLibraryJar.file.
   */
  file?: string;
  source: ModSource;
  /** When the current jar was put into the library, ISO 8601. */
  addedAt: string;
  sizeBytes: number;
  /**
   * SHA-256 of the current jar's bytes. This, not the filename, is what
   * reconcile compares a jar in the mods folder against to decide whether it is
   * already the right one - two different builds routinely ship under one name.
   */
  sha256: string;
  /** Earlier jars for this same mod, still on disk and still restorable. */
  superseded: ModLibraryJar[];
}

export interface ModLibraryResponse {
  ok: true;
  mods: ModLibraryEntry[];
}

/**
 * Which mods one world loads, as mod ids.
 *
 * Ids, not jar filenames: a filename carries the version (`AutoTorch-1.0.jar` ->
 * `-1.1.jar`), so a set stored as filenames would break on every update, while a
 * set stored as ids picks the new jar up at the world's next start.
 *
 * `world` is the name as it was last written. The set is looked up
 * case-insensitively, because Windows filenames are and `listWorlds` reads world
 * names off disk.
 */
export interface ModSet {
  world: string;
  modIds: string[];
  updatedAt: string;
}

export interface WorldModsResponse {
  ok: true;
  world: string;
  /**
   * What this world will start with. For a world nobody has chosen a set for,
   * that is what is installed in the mods folder right now, because that is what
   * `start` would seed the set with - reporting an empty list there would read
   * as "this world loads no mods", which is the opposite of the truth.
   * `configured` is what tells the two apart.
   */
  modIds: string[];
  /**
   * Ids in the set that the library has no jar for. A world in this state will
   * not start: reconcile refuses rather than launching a partial set.
   */
  missing: string[];
  /** Whether a set has ever been written for this world. */
  configured: boolean;
}

/** What reconciling the mods folder to a world's set actually did. */
export interface ReconcileSummary {
  world: string;
  modIds: string[];
  /** Jars found in the mods folder that the library did not have, and now does. */
  adopted: string[];
  /** Jar filenames removed from the mods folder because the set does not name them. */
  removed: string[];
  /** Jar filenames copied into the mods folder from the library. */
  copied: string[];
  /** Jar filenames already in place and left exactly as they were. */
  kept: string[];
}

export interface ReconcileResponse {
  ok: true;
  reconcile: ReconcileSummary;
}

export interface ModUploadResponse {
  ok: true;
  mod: ModLibraryEntry;
  /** True when a jar for this mod id was already in the library and was replaced. */
  replaced: boolean;
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
