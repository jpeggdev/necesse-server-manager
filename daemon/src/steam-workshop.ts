import type { DaemonConfig, WorkshopItem } from "./types.js";

/**
 * The only parts of a fetch Response this module reads. Narrow on purpose, the
 * same way `ChildLike` narrows a spawned process: a test hands in a plain
 * object rather than standing up a real Response, and the real global `fetch`
 * still satisfies it.
 */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

/** Injected like `SpawnFn`, so nothing here ever touches the network in tests. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<HttpResponseLike>;

/** Keyless. Details for a known set of published file ids. */
export const DETAILS_URL =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";

/** Requires a Steam Web API key; returns 403 Forbidden without one. */
export const QUERY_FILES_URL = "https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/";

/**
 * Neither Node's fetch nor Fastify imposes a deadline on a request that
 * connects and then goes quiet, and a Steam call that never returns would hold
 * an HTTP handler open for as long as the daemon runs. Ten seconds is far more
 * than either endpoint needs and turns "Steam is wedged" into a normal
 * unreachable error the caller already knows how to report.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

/** How many chars of an upstream error body to quote back. */
const BODY_SNIPPET = 300;

/**
 * How much of a workshop description survives the trip to a client.
 *
 * Steam sends the description in full, and it is large: the eight mods on the
 * live server total ~19,000 characters, one of them 7,800 on its own. Every
 * badge check fetches all of them, so shipping them whole would mean tens of
 * kilobytes per poll to render a tooltip and a one-line blurb. 280 is sized to
 * the two places it is actually consumed - one ellipsised line in a search
 * result (~110 chars even at the widest the mods pane can be dragged) and a
 * native title tooltip, which becomes a wall of text well before this - and
 * cuts the live payload by roughly 90%.
 *
 * Truncating here rather than in the client is deliberate: it is the only
 * place that can stop the bytes before they cross the wire.
 */
export const DESCRIPTION_LIMIT = 280;

/**
 * BBCode tags: `[h1]`, `[/hr]`, `[*]`, `[url=https://...]`. Bounded length so
 * an unmatched `[` in prose swallows a few characters at most instead of
 * everything up to the next bracket, and so the pattern cannot backtrack.
 */
const BBCODE_TAG = /\[\/?[a-z0-9*][^\]]{0,40}\]/gi;

/** Nothing nearer the cap than this is worth cutting a word in half for. */
const WORD_BOUNDARY_SLACK = 40;

/**
 * A workshop description reduced to something a tooltip or a single line can
 * hold: markup stripped, whitespace collapsed, cut at the limit on a word
 * boundary where one is close enough to the end to be worth using.
 */
export function toBlurb(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  const text = raw.replace(BBCODE_TAG, " ").replace(/\s+/g, " ").trim();
  if (text.length <= DESCRIPTION_LIMIT) return text;
  const cut = text.slice(0, DESCRIPTION_LIMIT);
  const space = cut.lastIndexOf(" ");
  const kept = space > DESCRIPTION_LIMIT - WORD_BOUNDARY_SLACK ? cut.slice(0, space) : cut;
  // Written as an escape, not a literal: this file is edited by tools that
  // match exact bytes, and a pasted ellipsis is the one character that cannot
  // be retyped reliably.
  return `${kept.trimEnd()}\u2026`;
}

export type WorkshopFailureKind =
  /** No Steam Web API key is set, and the operation needs one. */
  | "not-configured"
  /** The request never produced a response: DNS, connection, timeout. */
  | "unreachable"
  /** Steam answered, but with an error status or a body we cannot read. */
  | "upstream";

/**
 * Carries *why* a workshop call failed, so callers can distinguish a missing
 * key (fix the config) from Steam being down (try later) from Steam rejecting
 * the request (the message says what it said) instead of collapsing all three
 * into one opaque failure.
 */
export class WorkshopError extends Error {
  constructor(
    readonly kind: WorkshopFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "WorkshopError";
  }
}

export interface WorkshopSearchOptions {
  text?: string;
  count?: number;
  /** Opaque paging cursor from a previous page; Steam's first page is "*". */
  cursor?: string;
}

export interface WorkshopSearchResult {
  items: WorkshopItem[];
  /** null once Steam stops advancing the cursor, i.e. no further pages. */
  nextCursor: string | null;
  total: number;
}

/** Steam's `result` code for "this published file is fine". */
const RESULT_OK = 1;

interface RawDetail {
  publishedfileid?: unknown;
  result?: unknown;
  title?: unknown;
  description?: unknown;
  /**
   * Only QueryFiles produces this, and only when asked
   * (`return_short_description`). GetPublishedFileDetails has no such
   * parameter and never sends the field - confirmed against the live endpoint,
   * whose entries carry `description` alone - so both are read and whichever
   * turns up is used.
   */
  short_description?: unknown;
  preview_url?: unknown;
  time_updated?: unknown;
  file_size?: unknown;
  subscriptions?: unknown;
  banned?: unknown;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

function toItem(raw: RawDetail): WorkshopItem | null {
  const id = raw.publishedfileid;
  if (typeof id !== "string" || id.length === 0) return null;
  // GetPublishedFileDetails always sets `result`; QueryFiles omits it. Anything
  // other than 1 (9 = file not found, plus the removed cases) carries no
  // usable title or timestamp, so it is dropped rather than reported as an
  // entry with empty fields.
  if (raw.result !== undefined && raw.result !== RESULT_OK) return null;
  // A banned item comes back with result 1 and a perfectly good title, so it
  // has to be dropped explicitly. steamcmd cannot download one anonymously, so
  // reporting it as a live entry would offer an update badge for something
  // that can never install, and would resolve a name for an add that is going
  // to fail. `visibility` is deliberately NOT filtered on: unlisted items are
  // still downloadable by id and mod authors do use that, so excluding
  // non-public entries would reject mods that install perfectly well.
  if (raw.banned === true || raw.banned === 1) return null;
  const updated = raw.time_updated;
  const updatedMs = typeof updated === "number" || typeof updated === "string" ? num(updated) : 0;
  // The short form when Steam sent one, else the full description - which is
  // then cut down to the same size anyway, so a client cannot tell which
  // endpoint it came from or be handed a wall of BBCode by either.
  const shortDesc = raw.short_description;
  const description = toBlurb(
    typeof shortDesc === "string" && shortDesc.length > 0 ? shortDesc : raw.description,
  );
  return {
    id,
    title: typeof raw.title === "string" ? raw.title : "",
    previewUrl: typeof raw.preview_url === "string" ? raw.preview_url : "",
    description,
    // Reported as null rather than the unix epoch when Steam sent no
    // timestamp, so "we do not know" never reads as "updated in 1970".
    updatedAt: updatedMs > 0 ? new Date(updatedMs * 1000).toISOString() : null,
    fileSize: num(raw.file_size),
    subscriptions: num(raw.subscriptions),
  };
}

export class SteamWorkshop {
  constructor(
    private cfg: DaemonConfig,
    private fetchFn: FetchFn,
  ) {}

  /** Whether `search` can run at all. `getDetails` needs no key. */
  get keyConfigured(): boolean {
    return this.cfg.steamApiKey.trim().length > 0;
  }

  /**
   * Details for a list of workshop ids. Ids Steam has no usable entry for are
   * absent from the result rather than represented by a blank item, so the
   * caller matches by id and treats a miss as "Steam does not know this one".
   */
  async getDetails(ids: string[]): Promise<WorkshopItem[]> {
    // Steam answers an itemcount=0 request with an empty object; skipping the
    // round trip entirely also keeps "no managed mods" off the network.
    if (ids.length === 0) return [];
    const body = new URLSearchParams();
    body.set("itemcount", String(ids.length));
    ids.forEach((id, i) => body.set(`publishedfileids[${i}]`, id));
    const json = await this.request(
      DETAILS_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      "Steam's GetPublishedFileDetails endpoint",
    );
    return this.itemsFrom(json, "Steam's GetPublishedFileDetails endpoint").items;
  }

  /**
   * Full-text workshop search, which is the endpoint that needs a key.
   *
   * The key travels in the query string, so the built URL must never reach an
   * error message: this API has no authentication, and every error body it
   * produces is readable by anything on the LAN. Error text uses the endpoint's
   * name instead.
   */
  async search(opts: WorkshopSearchOptions = {}): Promise<WorkshopSearchResult> {
    const key = this.cfg.steamApiKey.trim();
    if (key.length === 0) {
      throw new WorkshopError(
        "not-configured",
        "No Steam Web API key is configured, and workshop search is the one Steam " +
          "endpoint that requires one. Add a key to the daemon's config.json on the " +
          "server (get one at https://steamcommunity.com/dev/apikey) and restart it. " +
          "Installing a mod by id and checking for mod updates work without a key.",
      );
    }
    const text = (opts.text ?? "").trim();
    const params = new URLSearchParams({
      key,
      appid: String(this.cfg.workshopAppId),
      // 0 = ranked by vote, which is what a typed query should rank by; 9 =
      // ranked by trend, the sensible default for browsing with no query.
      query_type: text.length > 0 ? "0" : "9",
      numperpage: String(opts.count ?? 20),
      cursor: opts.cursor ?? "*",
      return_metadata: "true",
      // Asks Steam to send its own trimmed blurb instead of the full BBCode
      // description. `toBlurb` truncates either one to the same size, so this
      // is a bandwidth saving on Steam's side of the hop rather than something
      // the output shape depends on - if Steam ignores the flag, the full
      // description arrives and is cut down exactly as it is for the details
      // endpoint, which never sends a short form at all.
      return_short_description: "true",
    });
    if (text.length > 0) params.set("search_text", text);
    const label = "Steam's QueryFiles endpoint";
    const json = await this.request(`${QUERY_FILES_URL}?${params.toString()}`, { method: "GET" }, label);
    const { items, response } = this.itemsFrom(json, label);
    const next = response.next_cursor;
    return {
      items,
      // Steam echoes the cursor back unchanged on the last page, which would
      // otherwise page forever.
      nextCursor: typeof next === "string" && next.length > 0 && next !== (opts.cursor ?? "*") ? next : null,
      total: num(response.total),
    };
  }

  /** Shared shape check: both endpoints answer with `response.publishedfiledetails`. */
  private itemsFrom(
    json: unknown,
    label: string,
  ): { items: WorkshopItem[]; response: Record<string, unknown> } {
    const response = (json as { response?: unknown }).response;
    if (typeof response !== "object" || response === null) {
      throw new WorkshopError("upstream", `${label} returned a body with no "response" object.`);
    }
    const details = (response as { publishedfiledetails?: unknown }).publishedfiledetails;
    // An empty result set legitimately omits the array, so an absent one is
    // "nothing matched"; a present-but-wrong-shape one is a real surprise.
    if (details === undefined) return { items: [], response: response as Record<string, unknown> };
    if (!Array.isArray(details)) {
      throw new WorkshopError(
        "upstream",
        `${label} returned a "publishedfiledetails" that is not an array.`,
      );
    }
    const items = (details as RawDetail[])
      .map(toItem)
      .filter((i): i is WorkshopItem => i !== null);
    return { items, response: response as Record<string, unknown> };
  }

  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    label: string,
  ): Promise<unknown> {
    let res: HttpResponseLike;
    try {
      res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      throw new WorkshopError("unreachable", `Could not reach ${label}: ${(e as Error).message}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new WorkshopError("upstream", `Could not read ${label}'s response: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new WorkshopError(
        "upstream",
        `${label} returned HTTP ${res.status} ${res.statusText}: ${text.slice(0, BODY_SNIPPET)}`,
      );
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new WorkshopError(
        "upstream",
        `${label} returned a body that is not JSON (${(e as Error).message}): ` +
          text.slice(0, BODY_SNIPPET),
      );
    }
  }
}
