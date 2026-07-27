import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeApi } from "../src/api";

const BASE = "http://192.168.1.106:8710";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status: number, body: unknown) {
  return { ok: false, status, json: async () => body };
}

describe("makeApi", () => {
  it("GETs status from the configured base url", async () => {
    fetchMock.mockResolvedValue(ok({ state: "stopped" }));
    const api = makeApi(BASE);
    expect((await api.status()).state).toBe("stopped");
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/status`, expect.anything());
  });

  it("POSTs the world name as JSON on start", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    await makeApi(BASE).start("Tulsa");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/server/start`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ world: "Tulsa" });
  });

  it("throws the daemon's own error text, not a generic message", async () => {
    fetchMock.mockResolvedValue(err(409, { ok: false, error: "Server is already running" }));
    await expect(makeApi(BASE).start("Tulsa")).rejects.toThrow("Server is already running");
  });

  it("distinguishes an unreachable daemon from a daemon error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(makeApi(BASE).status()).rejects.toThrow(/could not reach the daemon/i);
  });

  it("encodes the world name in the candidate query", async () => {
    fetchMock.mockResolvedValue(ok({ worlds: [], lastWorld: null, candidate: null }));
    await makeApi(BASE).worlds("Jeff and Eli");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/worlds?name=Jeff%20and%20Eli`);
  });

  it("DELETEs a mod by id", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    await makeApi(BASE).removeMod("3731244177");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/mods/3731244177`);
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});
