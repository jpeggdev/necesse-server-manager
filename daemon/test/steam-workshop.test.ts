import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SteamWorkshop,
  WorkshopError,
  DETAILS_URL,
  QUERY_FILES_URL,
  REQUEST_TIMEOUT_MS,
  DESCRIPTION_LIMIT,
  toBlurb,
} from "../src/steam-workshop.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { makeFakeFetch, detailsBody, type FakeFetch } from "./fixtures/fake-fetch.js";
import type { DaemonConfig } from "../src/types.js";

/**
 * Never a real key, and never a real request: every test here injects a fetch,
 * so the suite has no network dependency and nothing secret to leak.
 */
const FAKE_KEY = "0000000000000000000000000000TEST";

let cfg: DaemonConfig;
let net: FakeFetch;
let workshop: SteamWorkshop;

beforeEach(() => {
  cfg = { ...DEFAULT_CONFIG, steamApiKey: "" };
  net = makeFakeFetch();
  workshop = new SteamWorkshop(cfg, net.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toBlurb", () => {
  it("leaves a description shorter than the cap exactly as it is", () => {
    expect(toBlurb("Adds a fishing rod.")).toBe("Adds a fishing rod.");
  });

  it("collapses the CRLF runs Steam's descriptions are full of", () => {
    expect(toBlurb("One\r\n\r\nTwo   Three")).toBe("One Two Three");
  });

  it("cuts on a word boundary rather than mid-word", () => {
    const text = `${"alpha ".repeat(60)}omega`;
    const out = toBlurb(text);
    expect(out.endsWith("…")).toBe(true);
    // Nothing half-typed: every word before the ellipsis is whole.
    expect(out.slice(0, -1).trim().split(" ").every((w) => w === "alpha")).toBe(true);
  });

  it("still cuts at the cap when there is no word boundary to fall back on", () => {
    const out = toBlurb("x".repeat(DESCRIPTION_LIMIT * 2));
    expect(out.length).toBe(DESCRIPTION_LIMIT + 1);
  });

  it("treats a missing or non-string description as empty", () => {
    expect(toBlurb(undefined)).toBe("");
    expect(toBlurb(42)).toBe("");
    expect(toBlurb("")).toBe("");
  });

  it("does not let an unmatched bracket eat the rest of the text", () => {
    // Bounded tag pattern: prose containing a stray "[" keeps its words.
    expect(toBlurb("Costs [ 5 gold and adds a shop")).toContain("gold and adds a shop");
  });
});

/*
 * Nothing else in the suite would notice if the request deadline were deleted:
 * a fake fetch always answers. These pin it directly, because without it a
 * Steam that connects and then goes quiet holds an HTTP handler open for as
 * long as the daemon runs.
 */
describe("request deadline", () => {
  it("attaches a 10s abort signal to the keyless details call", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    net.respondJson(detailsBody([{ id: "111" }]));
    await workshop.getDetails(["111"]);
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    expect(net.calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(net.calls[0].signal?.aborted).toBe(false);
  });

  it("attaches one to the keyed search call too", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    cfg.steamApiKey = FAKE_KEY;
    net.respondJson({ response: { total: 0 } });
    await workshop.search({ text: "torch" });
    expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
    expect(net.calls[0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("getDetails", () => {
  it("posts the form-encoded id list Steam's keyless endpoint expects", async () => {
    net.respondJson(detailsBody([{ id: "111" }, { id: "222" }]));
    await workshop.getDetails(["111", "222"]);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe(DETAILS_URL);
    expect(net.calls[0].method).toBe("POST");
    const body = new URLSearchParams(net.calls[0].body);
    expect(body.get("itemcount")).toBe("2");
    expect(body.get("publishedfileids[0]")).toBe("111");
    expect(body.get("publishedfileids[1]")).toBe("222");
  });

  it("flattens time_updated into ISO and keeps the fields a UI needs", async () => {
    net.respondJson(
      detailsBody([{ id: "111", title: "Safe Haven QOL", timeUpdated: 1_700_000_000, subscriptions: 42 }]),
    );
    const [item] = await workshop.getDetails(["111"]);
    expect(item).toMatchObject({ id: "111", title: "Safe Haven QOL", subscriptions: 42 });
    expect(item.updatedAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
    expect(item.previewUrl).toMatch(/^https:/);
  });

  it("truncates the description before it can leave the daemon", async () => {
    // The live server's eight mods carry ~19,000 chars of description between
    // them, one of them 7,800 alone, and every badge check fetches all of them.
    const huge = `${"word ".repeat(4000)}end`;
    net.respondJson(detailsBody([{ id: "111", description: huge }]));
    const [item] = await workshop.getDetails(["111"]);
    expect(item.description.length).toBeLessThanOrEqual(DESCRIPTION_LIMIT + 1);
    expect(item.description).not.toContain("end");
  });

  it("strips BBCode so the blurb is prose rather than markup", async () => {
    net.respondJson(
      detailsBody([{ id: "111", description: "[h1]Safe Haven[/h1]\r\n[hr][/hr]\r\n[*] Adds bars" }]),
    );
    const [item] = await workshop.getDetails(["111"]);
    expect(item.description).toBe("Safe Haven Adds bars");
  });

  it("reports an empty description when Steam sent none", async () => {
    net.respondJson({
      response: { publishedfiledetails: [{ publishedfileid: "111", result: 1, title: "A" }] },
    });
    const [item] = await workshop.getDetails(["111"]);
    expect(item.description).toBe("");
  });

  it("drops an id Steam reports a non-1 result for rather than inventing a blank entry", async () => {
    // result 9 is Steam's "file not found" - a removed or mistyped id.
    net.respondJson(detailsBody([{ id: "111" }, { id: "999", result: 9 }]));
    const items = await workshop.getDetails(["111", "999"]);
    expect(items.map((i) => i.id)).toEqual(["111"]);
  });

  it("drops a banned item, which Steam still reports with result 1 and a good title", async () => {
    // steamcmd cannot download a banned item anonymously, so treating it as a
    // live entry would badge an update that can never install and would resolve
    // a name for an add that is going to fail.
    net.respondJson(detailsBody([{ id: "111" }, { id: "222", title: "Naughty", banned: true }]));
    const items = await workshop.getDetails(["111", "222"]);
    expect(items.map((i) => i.id)).toEqual(["111"]);
  });

  it("keeps a non-public item, since an unlisted mod still installs by id", async () => {
    net.respondJson({
      response: {
        publishedfiledetails: [
          { publishedfileid: "111", result: 1, title: "Unlisted", time_updated: 1, visibility: 3 },
        ],
      },
    });
    expect((await workshop.getDetails(["111"])).map((i) => i.id)).toEqual(["111"]);
  });

  it("reports null rather than the unix epoch when Steam sent no timestamp", async () => {
    net.respondJson(detailsBody([{ id: "111", timeUpdated: 0 }]));
    const [item] = await workshop.getDetails(["111"]);
    expect(item.updatedAt).toBeNull();
  });

  it("makes no request at all for an empty id list", async () => {
    expect(await workshop.getDetails([])).toEqual([]);
    expect(net.calls).toHaveLength(0);
  });

  it("needs no API key", async () => {
    net.respondJson(detailsBody([{ id: "111" }]));
    expect(cfg.steamApiKey).toBe("");
    await expect(workshop.getDetails(["111"])).resolves.toHaveLength(1);
  });

  it("classifies a transport failure as unreachable and keeps the underlying message", async () => {
    net.failWith("getaddrinfo ENOTFOUND api.steampowered.com");
    const e = await workshop.getDetails(["111"]).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(WorkshopError);
    expect((e as WorkshopError).kind).toBe("unreachable");
    expect((e as Error).message).toContain("ENOTFOUND");
  });

  it("classifies an error status as upstream and quotes what Steam said", async () => {
    net.respondRaw(500, "Internal Server Error", "steam is having a day");
    const e = await workshop.getDetails(["111"]).catch((err: unknown) => err);
    expect((e as WorkshopError).kind).toBe("upstream");
    expect((e as Error).message).toContain("500");
    expect((e as Error).message).toContain("steam is having a day");
  });

  it("does not pretend a non-JSON body is an empty result", async () => {
    net.respondRaw(200, "OK", "<html>maintenance</html>");
    const e = await workshop.getDetails(["111"]).catch((err: unknown) => err);
    expect((e as WorkshopError).kind).toBe("upstream");
    expect((e as Error).message).toMatch(/not JSON/i);
  });

  it("treats an answer with no publishedfiledetails as nothing found, not an error", async () => {
    net.respondJson({ response: { result: 1, resultcount: 0 } });
    expect(await workshop.getDetails(["111"])).toEqual([]);
  });
});

describe("search", () => {
  it("refuses with a 'not-configured' failure, and no request, when no key is set", async () => {
    const e = await workshop.search({ text: "torch" }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(WorkshopError);
    expect((e as WorkshopError).kind).toBe("not-configured");
    expect((e as Error).message).toMatch(/api key/i);
    // The point of the check: no confusing upstream 403 is ever produced.
    expect(net.calls).toHaveLength(0);
  });

  it("sends the key, appid, query and cursor Steam's QueryFiles expects", async () => {
    cfg.steamApiKey = FAKE_KEY;
    net.respondJson({
      response: { total: 3, next_cursor: "AoIIP", publishedfiledetails: [{ publishedfileid: "1" }] },
    });
    await workshop.search({ text: "torch", count: 5, cursor: "*" });
    const u = new URL(net.calls[0].url);
    expect(`${u.origin}${u.pathname}`).toBe(QUERY_FILES_URL);
    expect(u.searchParams.get("key")).toBe(FAKE_KEY);
    expect(u.searchParams.get("appid")).toBe(String(cfg.workshopAppId));
    expect(u.searchParams.get("search_text")).toBe("torch");
    expect(u.searchParams.get("numperpage")).toBe("5");
    expect(u.searchParams.get("cursor")).toBe("*");
    expect(u.searchParams.get("return_metadata")).toBe("true");
    // Asks Steam for its own trimmed blurb rather than the full BBCode body.
    expect(u.searchParams.get("return_short_description")).toBe("true");
    // 0 = ranked by vote, which is what a typed query should rank by.
    expect(u.searchParams.get("query_type")).toBe("0");
  });

  it("prefers Steam's short_description when it sends one", async () => {
    cfg.steamApiKey = FAKE_KEY;
    net.respondJson({
      response: {
        total: 1,
        publishedfiledetails: [
          {
            publishedfileid: "1",
            title: "A",
            short_description: "The short one.",
            description: "[h1]The very long one[/h1]",
          },
        ],
      },
    });
    const { items } = await workshop.search({ text: "a" });
    expect(items[0].description).toBe("The short one.");
  });

  it("falls back to the full description if Steam ignores the short flag", async () => {
    // The flag is a bandwidth saving on Steam's side, not something the output
    // shape depends on - GetPublishedFileDetails never sends a short form at
    // all, and that path has to produce the same kind of blurb.
    cfg.steamApiKey = FAKE_KEY;
    net.respondJson({
      response: {
        total: 1,
        publishedfiledetails: [
          { publishedfileid: "1", title: "A", description: "[h1]Only the long one[/h1]" },
        ],
      },
    });
    const { items } = await workshop.search({ text: "a" });
    expect(items[0].description).toBe("Only the long one");
  });

  it("ranks by trend and omits search_text when browsing with no query", async () => {
    cfg.steamApiKey = FAKE_KEY;
    net.respondJson({ response: { total: 0 } });
    await workshop.search({});
    const u = new URL(net.calls[0].url);
    expect(u.searchParams.get("query_type")).toBe("9");
    expect(u.searchParams.has("search_text")).toBe(false);
  });

  it("returns the next cursor, and null once Steam stops advancing it", async () => {
    cfg.steamApiKey = FAKE_KEY;
    net.respondJson({ response: { total: 9, next_cursor: "PAGE2", publishedfiledetails: [] } });
    expect((await workshop.search({ cursor: "*" })).nextCursor).toBe("PAGE2");

    // Steam echoes the cursor back unchanged on the last page; paging on that
    // would loop forever.
    net.respondJson({ response: { total: 9, next_cursor: "PAGE2", publishedfiledetails: [] } });
    expect((await workshop.search({ cursor: "PAGE2" })).nextCursor).toBeNull();
  });

  it("never puts the key in an error message, since error bodies go out over the LAN", async () => {
    cfg.steamApiKey = FAKE_KEY;
    net.respondRaw(403, "Forbidden", "<html>Access is denied...</html>");
    const e = await workshop.search({ text: "torch" }).catch((err: unknown) => err);
    expect((e as WorkshopError).kind).toBe("upstream");
    expect((e as Error).message).not.toContain(FAKE_KEY);
    expect((e as Error).message).toContain("403");

    net.failWith("connect ETIMEDOUT 23.4.5.6:443");
    const e2 = await workshop.search({ text: "torch" }).catch((err: unknown) => err);
    expect((e2 as WorkshopError).kind).toBe("unreachable");
    expect((e2 as Error).message).not.toContain(FAKE_KEY);
  });

  it("reports whether a key is configured without exposing it", () => {
    expect(workshop.keyConfigured).toBe(false);
    cfg.steamApiKey = "   ";
    expect(workshop.keyConfigured).toBe(false);
    cfg.steamApiKey = FAKE_KEY;
    expect(workshop.keyConfigured).toBe(true);
  });
});
