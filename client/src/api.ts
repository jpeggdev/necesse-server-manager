import type { ModListResponse, StatusPayload, WorldInfo } from "./types";

export interface WorldsResponse {
  worlds: WorldInfo[];
  lastWorld: string | null;
  candidate: { name: string; valid: boolean; exists: boolean } | null;
}

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
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
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
    start: (world: string) => post<{ ok: true }>("/api/server/start", { world }),
    stop: () => post<{ ok: true }>("/api/server/stop"),
    kill: () => post<{ ok: true }>("/api/server/kill"),
    updateServer: () => post<{ ok: true; taskId: string }>("/api/server/update"),
    mods: () => request<ModListResponse>(`${base}/api/mods`),
    addMod: (id: string, name: string) => post<{ ok: true; taskId: string }>("/api/mods", { id, name }),
    removeMod: (id: string) =>
      request<{ ok: true }>(`${base}/api/mods/${id}`, { method: "DELETE" }),
    updateAllMods: () => post<{ ok: true; taskId: string }>("/api/mods/update-all"),
  };
}

export type Api = ReturnType<typeof makeApi>;
