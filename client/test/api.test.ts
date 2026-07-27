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

  it("omits the name entirely when adding a mod by id alone", async () => {
    // Not `name: ""` - the daemon branches on an explicit name winning, and an
    // empty string must not be mistaken for one.
    fetchMock.mockResolvedValue(ok({ ok: true, taskId: "t1" }));
    await makeApi(BASE).addMod("3731244177");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "3731244177" });
  });

  it("sends an explicit name when one is supplied", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, taskId: "t1" }));
    await makeApi(BASE).addMod("3731244177", "  Safe Haven QOL  ");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      id: "3731244177",
      name: "Safe Haven QOL",
    });
  });

  it("surfaces the daemon's 400 asking for a name", async () => {
    fetchMock.mockResolvedValue(
      err(400, { ok: false, error: "Steam has no title for 999. Supply a name explicitly." }),
    );
    await expect(makeApi(BASE).addMod("999")).rejects.toThrow(/supply a name/i);
  });

  it("GETs mod updates from their own endpoint, separate from the mod list", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, checkedAt: "2026-07-27T00:00:00.000Z", mods: [] }));
    await makeApi(BASE).modUpdates();
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/mods/updates`);
  });

  it("puts the search text, cursor and count in the query string", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, items: [], nextCursor: null, total: 0 }));
    await makeApi(BASE).workshopSearch("safe haven", "AoIIQySEBHDOj9hp", 5);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/api/workshop/search");
    expect(url.searchParams.get("q")).toBe("safe haven");
    expect(url.searchParams.get("cursor")).toBe("AoIIQySEBHDOj9hp");
    expect(url.searchParams.get("count")).toBe("5");
  });

  it("omits an empty query so the daemon browses rather than searching for nothing", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true, items: [], nextCursor: null, total: 0 }));
    await makeApi(BASE).workshopSearch("   ");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/workshop/search`);
  });

  it("surfaces the daemon's 503 no-key message from search verbatim", async () => {
    const message = "No Steam Web API key is configured. Set steamApiKey in config.json.";
    fetchMock.mockResolvedValue(err(503, { ok: false, error: message }));
    await expect(makeApi(BASE).workshopSearch("x")).rejects.toThrow(message);
  });

  it("DELETEs a mod by id", async () => {
    fetchMock.mockResolvedValue(ok({ ok: true }));
    await makeApi(BASE).removeMod("3731244177");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/mods/3731244177`);
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});
