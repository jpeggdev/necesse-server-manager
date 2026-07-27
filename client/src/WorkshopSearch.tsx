import { useRef, useState } from "react";
import type { WorkshopItem, WorkshopSearchResponse } from "./types";

export interface WorkshopSearchProps {
  /**
   * Runs GET /api/workshop/search. Injected rather than reached for directly so
   * this component owns no base url and every test drives it without a fetch.
   */
  search: (q: string, cursor?: string) => Promise<WorkshopSearchResponse>;
  /**
   * Installs by workshop id alone - the daemon resolves the title from Steam.
   * The same callback the Add form uses, so installing from a search result
   * goes through exactly the same guard, error and refresh path.
   */
  onInstall: (id: string) => void;
  /** True while a mod/server task is streaming. */
  busy: boolean;
  running: boolean;
  /** Managed mod ids, so an already-installed result offers no second install. */
  installedIds: string[];
}

/** 29581 -> "30k". The exact figure lives in the row's tooltip. */
function formatSubs(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
}

function rowTitle(item: WorkshopItem): string {
  const parts = [
    item.title,
    `Workshop id: ${item.id}`,
    `${item.subscriptions.toLocaleString()} subscribers`,
  ];
  if (item.updatedAt !== null) parts.push(`Updated ${item.updatedAt.slice(0, 10)}`);
  if (item.fileSize > 0) parts.push(`${Math.round(item.fileSize / 1024)} KB`);
  return parts.join("\n");
}

export function WorkshopSearch({ search, onInstall, busy, running, installedIds }: WorkshopSearchProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<WorkshopItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const locked = busy || running;

  // Same shape as App's candidate guard: a slow first page can land after the
  // user has already run a second search, and only the newest request may
  // write results. Paging is included, so a "Load more" answered after a fresh
  // search cannot append a previous query's items onto the new list.
  const seq = useRef(0);

  const runSearch = (cursor?: string) => {
    const mine = ++seq.current;
    setLoading(true);
    setSearched(true);
    search(query, cursor)
      .then((r) => {
        if (mine !== seq.current) return;
        setItems((prev) => (cursor === undefined ? r.items : [...prev, ...r.items]));
        setNextCursor(r.nextCursor);
        setTotal(r.total);
        setError(null);
      })
      .catch((e: Error) => {
        if (mine !== seq.current) return;
        // The daemon's own words, verbatim. A box with no Steam API key gets a
        // 503 whose message says exactly that and exactly where to fix it;
        // replacing it with "search failed" would throw away the only
        // actionable thing in the response.
        setError(e.message);
        if (cursor === undefined) {
          setItems([]);
          setNextCursor(null);
          setTotal(0);
        }
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  };

  return (
    <div className="workshop">
      <form
        className="workshop-form"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch();
        }}
      >
        <label htmlFor="workshop-q">Search the Steam Workshop</label>
        <input
          id="workshop-q"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Leave empty to browse trending"
        />
        {/* Deliberately NOT disabled while a search is outstanding: the
            daemon gives Steam a full 10s before it gives up, and freezing the
            one control the user has for that long is worse than allowing a
            second request. The sequence guard above is what makes overlapping
            searches safe, so the button does not have to. */}
        <button type="submit">Search</button>
      </form>

      {error !== null && (
        <p className="hint hint-bad" role="alert">
          {error}
        </p>
      )}

      {loading && items.length === 0 && <p className="hint">Searching&hellip;</p>}

      {searched && !loading && error === null && items.length === 0 && (
        <p className="hint">No workshop mods matched.</p>
      )}

      {items.length > 0 && (
        <p className="hint">
          Showing {items.length} of {total}
        </p>
      )}

      {running && <p className="hint hint-warn">Stop the server to install mods.</p>}
      {!running && busy && (
        <p className="hint hint-warn">A task is already running &mdash; wait for it to finish.</p>
      )}

      <ul className="workshop-list">
        {items.map((item) => {
          const installed = installedIds.includes(item.id);
          return (
            <li key={item.id} title={rowTitle(item)}>
              {/* Decorative: the title sits right beside it, so an alt would
                  only make a screen reader say the name twice. */}
              {item.previewUrl.length > 0 && (
                <img className="workshop-thumb" src={item.previewUrl} alt="" loading="lazy" />
              )}
              <span className="mod-name">{item.title}</span>
              <span className="workshop-subs" title={`${item.subscriptions.toLocaleString()} subscribers`}>
                {formatSubs(item.subscriptions)}
              </span>
              <button
                aria-label={`Install ${item.title}`}
                disabled={locked || installed}
                title={
                  installed
                    ? "Already installed"
                    : running
                      ? "Stop the server to change mods"
                      : busy
                        ? "A task is already running"
                        : "Installs by workshop id; the daemon resolves the name from Steam"
                }
                onClick={() => onInstall(item.id)}
              >
                {installed ? "Installed" : "Install"}
              </button>
            </li>
          );
        })}
      </ul>

      {nextCursor !== null && (
        <button
          className="workshop-more"
          disabled={loading}
          onClick={() => runSearch(nextCursor)}
        >
          Load more
        </button>
      )}
    </div>
  );
}
