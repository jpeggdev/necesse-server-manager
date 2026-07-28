import type {
  ModLibraryResponse,
  ModListResponse,
  ModUpdatesResponse,
  ModUploadResponse,
  ReconcileResponse,
  StatusPayload,
  WorkshopSearchResponse,
  WorldInfo,
  WorldModsResponse,
  WorldSettingsResponse,
  WorldSettingsWriteResponse,
} from "./types";

export interface WorldsResponse {
  worlds: WorldInfo[];
  lastWorld: string | null;
  candidate: { name: string; valid: boolean; exists: boolean } | null;
}

/**
 * The daemon's own message, plus the status it came with. The text belongs to
 * the daemon and is never reworded here, but the UI has to tell one failure
 * from another - specifically a 504 from POST /api/server/stop, which means
 * the stop timed out and the process was deliberately left running, from a 409
 * that means it was never running at all. Only the former should unlock a
 * force kill, and matching on message text to decide that would be a trap for
 * whoever next edits the daemon's wording.
 */
export class DaemonError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DaemonError";
    this.status = status;
  }
}

/** The daemon answers a stop that ran past `stopTimeoutMs` with this. */
export const STOP_TIMEOUT_STATUS = 504;

/**
 * A new value for one world setting, in the JSON shape the daemon validates:
 * a boolean for a boolean field, a number for an int/float, a string for an
 * enum. The daemon type-checks every one of them and answers 400 with the
 * reason, so this type is a convenience for callers rather than the guard.
 */
export type WorldSettingValue = boolean | number | string;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      // Only claim a JSON body when one is actually being sent - Fastify's
      // default JSON parser rejects an empty body under this header with
      // FST_ERR_CTP_EMPTY_JSON_BODY (400), which broke every bodyless
      // mutation (stop/kill/updateServer/updateAllMods/removeMod).
      ...(init?.body === undefined ? {} : { headers: { "content-type": "application/json" } }),
    });
  } catch (e) {
    throw new Error(`Could not reach the daemon at ${url}: ${(e as Error).message}`);
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new DaemonError(body?.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return body as T;
}

export function makeApi(base: string) {
  const post = <T>(path: string, payload?: unknown): Promise<T> =>
    request<T>(`${base}${path}`, {
      method: "POST",
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

  return {
    status: () => request<StatusPayload>(`${base}/api/status`),
    worlds: (name?: string) =>
      request<WorldsResponse>(
        name === undefined
          ? `${base}/api/worlds`
          : `${base}/api/worlds?name=${encodeURIComponent(name)}`,
      ),
    /**
     * A world's `worldSettings.cfg` as the daemon reads it: every line the file
     * has, in file order, with the type and option set of each. Reading is
     * allowed whatever the server is doing - only the write needs it stopped.
     */
    worldSettings: (world: string) =>
      request<WorldSettingsResponse>(
        `${base}/api/worlds/${encodeURIComponent(world)}/settings`,
      ),
    /**
     * Applies a PARTIAL set of changes: every key sent is a line the daemon
     * rewrites, so a caller that sent the whole form would rewrite lines the
     * user never touched. Send only what changed.
     */
    saveWorldSettings: (world: string, changes: Record<string, WorldSettingValue>) =>
      request<WorldSettingsWriteResponse>(
        `${base}/api/worlds/${encodeURIComponent(world)}/settings`,
        { method: "PUT", body: JSON.stringify(changes) },
      ),
    start: (world: string) => post<{ ok: true }>("/api/server/start", { world }),
    stop: () => post<{ ok: true }>("/api/server/stop"),
    kill: () => post<{ ok: true }>("/api/server/kill"),
    updateServer: () => post<{ ok: true; taskId: string }>("/api/server/update"),
    mods: () => request<ModListResponse>(`${base}/api/mods`),
    /**
     * Which managed mods have a newer workshop entry. A separate call from
     * mods() on purpose: the mod list is read off the server's disk and must
     * keep working when Steam is down, so this one failing (502) costs badges
     * and nothing else. Never fold the two together.
     */
    modUpdates: () => request<ModUpdatesResponse>(`${base}/api/mods/updates`),
    /**
     * Empty `q` is a browse rather than an error - the daemon omits
     * `search_text` and Steam ranks by trend. `cursor` comes from a previous
     * response's `nextCursor`; the daemon already collapses Steam's
     * echo-the-cursor-back-forever behaviour into a null.
     */
    workshopSearch: (q: string, cursor?: string, count?: number) => {
      const params = new URLSearchParams();
      if (q.trim().length > 0) params.set("q", q.trim());
      if (cursor !== undefined) params.set("cursor", cursor);
      if (count !== undefined) params.set("count", String(count));
      const qs = params.toString();
      return request<WorkshopSearchResponse>(
        `${base}/api/workshop/search${qs.length > 0 ? `?${qs}` : ""}`,
      );
    },
    /**
     * `name` is optional: with no name the daemon resolves the title from
     * Steam, which is what makes installing straight out of workshop search
     * possible. The key is omitted rather than sent empty so the daemon's
     * "an explicit name always wins" branch is never entered with nothing in
     * it. If Steam cannot resolve it the daemon answers 400 asking for a name,
     * and that message is what the user needs to see.
     */
    addMod: (id: string, name?: string) =>
      post<{ ok: true; taskId: string }>(
        "/api/mods",
        name !== undefined && name.trim().length > 0 ? { id, name: name.trim() } : { id },
      ),
    removeMod: (id: string) =>
      request<{ ok: true }>(`${base}/api/mods/${id}`, { method: "DELETE" }),
    updateAllMods: () => post<{ ok: true; taskId: string }>("/api/mods/update-all"),
    /**
     * Every mod the daemon holds a jar for. This, not the mods folder, is what a
     * world's set is chosen from: the folder only ever holds one world's worth
     * at a time.
     */
    modLibrary: () => request<ModLibraryResponse>(`${base}/api/mods/library`),
    /**
     * Which mods a world will load. For a world nobody has chosen a set for
     * this reports what starting it would seed the set with - what is installed
     * right now - with `configured: false` saying the choice has not been made.
     */
    worldMods: (world: string) =>
      request<WorldModsResponse>(`${base}/api/worlds/${encodeURIComponent(world)}/mods`),
    /**
     * Chooses which mods a world loads. Takes effect at that world's next
     * start, because the game reads its mod set once, at startup. Every id must
     * be one the library holds; the daemon answers 400 naming any that is not.
     */
    saveWorldMods: (world: string, modIds: string[]) =>
      request<WorldModsResponse>(`${base}/api/worlds/${encodeURIComponent(world)}/mods`, {
        method: "PUT",
        body: JSON.stringify({ modIds }),
      }),
    /**
     * Uploads a jar into the library as a RAW body, not multipart: a jar upload
     * is one file with no other form fields, so multipart would buy only a
     * dependency. The content-type is what routes it to the daemon's buffer
     * parser and must be set - `request()` above only sets a JSON one, so this
     * call deliberately does not go through it.
     *
     * `filename` is a label; the mod's identity comes from the `mod.info` inside
     * the bytes, which the daemon validates before storing anything.
     */
    uploadMod: async (bytes: ArrayBuffer | Uint8Array, filename?: string) => {
      const url =
        `${base}/api/mods/upload` +
        (filename === undefined ? "" : `?filename=${encodeURIComponent(filename)}`);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/java-archive" },
          body: bytes as BodyInit,
        });
      } catch (e) {
        throw new Error(`Could not reach the daemon at ${url}: ${(e as Error).message}`);
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new DaemonError(body?.error ?? `${res.status} ${res.statusText}`, res.status);
      return body as ModUploadResponse;
    },
    /**
     * Applies a world's set to the mods folder without starting the server -
     * the same work `start` does first. Refused while the server is running,
     * because the game reads that folder once at startup.
     */
    reconcileMods: (world: string) => post<ReconcileResponse>("/api/mods/reconcile", { world }),
  };
}

export type Api = ReturnType<typeof makeApi>;
