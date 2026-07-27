import type { FetchFn, HttpResponseLike } from "../../src/steam-workshop.js";

export interface FetchRecord {
  url: string;
  method: string;
  body: string;
}

export interface FakeFetch {
  fetch: FetchFn;
  calls: FetchRecord[];
  /** Next response, as a JSON body with a 200. */
  respondJson(payload: unknown): void;
  /** Next response, verbatim, with the given status. */
  respondRaw(status: number, statusText: string, body: string): void;
  /** Next call rejects, as a DNS failure or a timeout would. */
  failWith(message: string): void;
}

/**
 * Stands in for the network so no test ever reaches Steam. The queued
 * behaviour applies to every call until it is replaced, which is all any of
 * these tests need - none of them issue two different Steam calls.
 */
export function makeFakeFetch(): FakeFetch {
  const calls: FetchRecord[] = [];

  const res = (status: number, statusText: string, body: string): HttpResponseLike => ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: () => Promise.resolve(body),
  });

  // Default: Steam answered, and knows nothing about whatever was asked.
  let next: () => Promise<HttpResponseLike> = () =>
    Promise.resolve(res(200, "OK", JSON.stringify({ response: {} })));

  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ?? "" });
      return next();
    },
    respondJson(payload) {
      next = () => Promise.resolve(res(200, "OK", JSON.stringify(payload)));
    },
    respondRaw(status, statusText, body) {
      next = () => Promise.resolve(res(status, statusText, body));
    },
    failWith(message) {
      next = () => Promise.reject(new Error(message));
    },
  };
}

/** A GetPublishedFileDetails-shaped body for the given items. */
export function detailsBody(
  items: Array<{
    id: string;
    title?: string;
    timeUpdated?: number;
    result?: number;
    subscriptions?: number;
    previewUrl?: string;
  }>,
): unknown {
  return {
    response: {
      result: 1,
      resultcount: items.length,
      publishedfiledetails: items.map((i) => ({
        publishedfileid: i.id,
        result: i.result ?? 1,
        title: i.title ?? `Mod ${i.id}`,
        description: "whatever",
        preview_url: i.previewUrl ?? `https://images.example/${i.id}.jpg`,
        time_updated: i.timeUpdated ?? 1_700_000_000,
        file_size: "12345",
        subscriptions: i.subscriptions ?? 7,
        banned: false,
        visibility: 0,
      })),
    },
  };
}
