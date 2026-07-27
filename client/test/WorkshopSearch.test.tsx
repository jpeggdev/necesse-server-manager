import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkshopSearch } from "../src/WorkshopSearch";
import type { WorkshopSearchResponse } from "../src/types";

const ultraStorage = {
  id: "3397986280",
  title: "Ultra Storage",
  previewUrl: "https://images.steamusercontent.com/ugc/26556371929375720/91BB72.jpg",
  description: "Adds a much larger storage chest and a sorting upgrade.",
  updatedAt: "2025-11-22T10:14:40.000Z",
  fileSize: 336628,
  subscriptions: 29581,
};
const portableStorage = {
  id: "2831152355",
  title: "Portable Storage",
  previewUrl: "",
  description: "",
  updatedAt: null,
  fileSize: 71586,
  subscriptions: 3173,
};

function page(items: unknown[], nextCursor: string | null, total = items.length): WorkshopSearchResponse {
  return { ok: true, items, nextCursor, total } as WorkshopSearchResponse;
}

function setup(overrides = {}) {
  const props = {
    search: vi.fn(async () => page([ultraStorage, portableStorage], null, 2)),
    onInstall: vi.fn(),
    busy: false,
    running: false,
    installedIds: [] as string[],
    ...overrides,
  };
  render(<WorkshopSearch {...props} />);
  return props;
}

async function runSearch(text?: string) {
  if (text !== undefined) await userEvent.type(screen.getByLabelText(/search the steam workshop/i), text);
  await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
}

describe("WorkshopSearch", () => {
  it("searches for the typed text and lists the results by title", async () => {
    const props = setup();
    await runSearch("storage");
    await screen.findByText("Ultra Storage");
    expect(props.search).toHaveBeenCalledWith("storage", undefined);
    expect(screen.getByText("Portable Storage")).toBeTruthy();
  });

  it("shows a thumbnail for a result that has one, and none for a result that does not", async () => {
    setup();
    await runSearch("storage");
    await screen.findByText("Ultra Storage");
    const withPreview = screen.getByText("Ultra Storage").closest("li");
    const withoutPreview = screen.getByText("Portable Storage").closest("li");
    expect(withPreview?.querySelector("img")?.getAttribute("src")).toBe(ultraStorage.previewUrl);
    expect(withoutPreview?.querySelector("img")).toBeNull();
  });

  it("leaves the thumbnail out of the accessibility tree, since the title is right beside it", async () => {
    setup();
    await runSearch("storage");
    await screen.findByText("Ultra Storage");
    const img = screen.getByText("Ultra Storage").closest("li")?.querySelector("img");
    expect(img?.getAttribute("alt")).toBe("");
  });

  it("shows the subscriber count, with the exact figure in a tooltip", async () => {
    setup();
    await runSearch("storage");
    await screen.findByText("Ultra Storage");
    const subs = screen.getByText("30k");
    expect(subs.getAttribute("title")).toMatch(/subscriber/i);
  });

  it("installs a result by id alone, letting the daemon resolve the name", async () => {
    const props = setup();
    await runSearch("storage");
    await screen.findByText("Ultra Storage");
    await userEvent.click(screen.getByRole("button", { name: /install ultra storage/i }));
    expect(props.onInstall).toHaveBeenCalledWith("3397986280");
  });

  it("browses rather than erroring when the query is empty", async () => {
    const props = setup();
    await runSearch();
    await screen.findByText("Ultra Storage");
    expect(props.search).toHaveBeenCalledWith("", undefined);
  });

  it("shows the daemon's own no-key message rather than a generic failure", async () => {
    const message =
      "Workshop search needs a Steam Web API key. Set steamApiKey in the daemon's config.json.";
    setup({ search: vi.fn(async () => Promise.reject(new Error(message))) });
    await runSearch("storage");
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("keeps the search box usable after a failure so the user can retry", async () => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error("Steam is unreachable"))
      .mockResolvedValueOnce(page([ultraStorage], null, 1));
    setup({ search });
    await runSearch("storage");
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByText("Ultra Storage");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when nothing matched", async () => {
    setup({ search: vi.fn(async () => page([], null, 0)) });
    await runSearch("zzzz");
    expect(await screen.findByText(/no workshop mods matched/i)).toBeTruthy();
  });

  it("pages with nextCursor and appends rather than replacing", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce(page([ultraStorage], "CURSOR2", 2))
      .mockResolvedValueOnce(page([portableStorage], null, 2));
    setup({ search });
    await runSearch("storage");
    await screen.findByText("Ultra Storage");

    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByText("Portable Storage");
    expect(search).toHaveBeenLastCalledWith("storage", "CURSOR2");
    // The first page must still be there.
    expect(screen.getByText("Ultra Storage")).toBeTruthy();
  });

  it("withdraws Load more on the last page", async () => {
    setup();
    await runSearch("storage");
    await screen.findByText("Ultra Storage");
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });

  it("refuses to install while the server is running, and says why", async () => {
    const props = setup({ running: true });
    await runSearch("storage");
    await screen.findByText("Ultra Storage");
    const install = screen.getByRole("button", { name: /install ultra storage/i });
    expect(install).toBeDisabled();
    expect(install.getAttribute("title")).toMatch(/stop the server/i);
    expect(screen.getByText(/stop the server to install mods/i)).toBeTruthy();
    expect(props.onInstall).not.toHaveBeenCalled();
  });

  it("refuses to install while a task is in flight, and says why", async () => {
    setup({ busy: true });
    await runSearch("storage");
    await screen.findByText("Ultra Storage");
    const install = screen.getByRole("button", { name: /install ultra storage/i });
    expect(install).toBeDisabled();
    expect(install.getAttribute("title")).toMatch(/already running/i);
    expect(screen.getByText(/already running/i)).toBeTruthy();
  });

  it("offers no second install for a mod that is already managed", async () => {
    setup({ installedIds: ["3397986280"] });
    await runSearch("storage");
    await screen.findByText("Ultra Storage");
    expect(screen.getByRole("button", { name: /install ultra storage/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /install portable storage/i })).toBeEnabled();
  });

  it("shows the daemon's blurb under the title, and nothing when there is none", async () => {
    setup();
    await runSearch("storage");
    await screen.findByText("Ultra Storage");
    expect(screen.getByText(ultraStorage.description)).toBeTruthy();
    // An empty description renders no element at all, not an empty line.
    const bare = screen.getByText("Portable Storage").closest("li");
    expect(bare?.querySelector(".workshop-blurb")).toBeNull();
  });

  it("pages with the query the cursor was minted for, not whatever the box says now", async () => {
    // Steam ranks a typed search by vote and an empty one by trend, so
    // replaying a cursor against different text pages through a different
    // result set - and the rows would be appended under the old list anyway.
    const search = vi
      .fn()
      .mockResolvedValueOnce(page([ultraStorage], "CURSOR2", 2))
      .mockResolvedValueOnce(page([portableStorage], null, 2));
    setup({ search });
    await runSearch("storage");
    await screen.findByText("Ultra Storage");

    // The user retypes but never submits.
    await userEvent.clear(screen.getByLabelText(/search the steam workshop/i));
    await userEvent.type(screen.getByLabelText(/search the steam workshop/i), "magic");
    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByText("Portable Storage");

    expect(search).toHaveBeenLastCalledWith("storage", "CURSOR2");
  });

  it("pages an empty browse with the empty query, not with text typed since", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce(page([ultraStorage], "CURSOR2", 2))
      .mockResolvedValueOnce(page([portableStorage], null, 2));
    setup({ search });
    await runSearch();
    await screen.findByText("Ultra Storage");

    await userEvent.type(screen.getByLabelText(/search the steam workshop/i), "magic");
    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByText("Portable Storage");

    expect(search).toHaveBeenLastCalledWith("", "CURSOR2");
  });

  it("shows one row per mod when a page repeats an id", async () => {
    // Steam's cursor walks a result set that can shift between pages, so the
    // same id legitimately arrives twice - which would also be a duplicate key.
    const search = vi
      .fn()
      .mockResolvedValueOnce(page([ultraStorage], "CURSOR2", 2))
      .mockResolvedValueOnce(page([ultraStorage, portableStorage], null, 2));
    setup({ search });
    await runSearch("storage");
    await screen.findByText("Ultra Storage");
    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByText("Portable Storage");

    expect(screen.getAllByText("Ultra Storage")).toHaveLength(1);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("clears a previous failure as soon as the next search starts", async () => {
    // Otherwise a 503 sits beside "Searching..." for the daemon's whole 10s
    // Steam timeout, describing a request that is already over.
    let releaseSecond: (v: WorkshopSearchResponse) => void = () => {};
    const search = vi
      .fn()
      .mockRejectedValueOnce(new Error("Steam is unreachable"))
      .mockImplementationOnce(() => new Promise<WorkshopSearchResponse>((r) => (releaseSecond = r)));
    setup({ search });

    await runSearch("storage");
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    // Still in flight: the stale message must already be gone.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/searching/i)).toBeTruthy();

    releaseSecond(page([ultraStorage], null, 1));
    await screen.findByText("Ultra Storage");
  });

  it("keeps the results already on screen when a page fails", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce(page([ultraStorage], "CURSOR2", 2))
      .mockRejectedValueOnce(new Error("Steam is unreachable"));
    setup({ search });
    await runSearch("storage");
    await screen.findByText("Ultra Storage");

    await userEvent.click(screen.getByRole("button", { name: /load more/i }));
    await screen.findByRole("alert");
    expect(screen.getByText("Ultra Storage")).toBeTruthy();
  });

  it("ignores a slow earlier search whose results land after a newer one", async () => {
    // Same hazard the world-name candidate lookup guards against: two requests
    // in flight, the stale one answering last and overwriting the fresh list.
    let releaseFirst: (v: WorkshopSearchResponse) => void = () => {};
    const search = vi
      .fn()
      .mockImplementationOnce(() => new Promise<WorkshopSearchResponse>((r) => (releaseFirst = r)))
      .mockResolvedValueOnce(page([portableStorage], null, 1));
    setup({ search });

    await runSearch("storage");
    await userEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByText("Portable Storage");

    releaseFirst(page([ultraStorage], null, 1));
    await waitFor(() => expect(screen.getByText("Portable Storage")).toBeTruthy());
    expect(screen.queryByText("Ultra Storage")).toBeNull();
  });
});
