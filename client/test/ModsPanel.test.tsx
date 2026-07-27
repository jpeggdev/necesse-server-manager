import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModsPanel } from "../src/ModsPanel";

const mods = {
  managed: [
    { id: "3731244177", name: "Safe Haven QOL", jar: "SafeHavenQOL-1.2.0-2.6.jar", lastUpdated: "2026-07-26T00:00:00.000Z" },
  ],
  untracked: [{ jar: "MysteryMod.jar" }],
};

const updateAvailable = [
  {
    id: "3731244177",
    title: "Safe Haven QOL",
    previewUrl: "https://images.steamusercontent.com/ugc/1/abc.jpg",
    description: "Custom stat bars, cooldown icons and a better map.",
    workshopUpdatedAt: "2026-07-27T00:00:00.000Z",
    installedAt: "2026-07-26T00:00:00.000Z",
    onWorkshop: true,
    updateAvailable: true,
  },
];

function setup(overrides = {}) {
  const props = {
    mods,
    busy: false,
    running: false,
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onUpdateAll: vi.fn(),
    ...overrides,
  };
  render(<ModsPanel {...props} />);
  return props;
}

describe("ModsPanel", () => {
  it("lists managed mods by name, keeping the row scannable", () => {
    setup();
    expect(screen.getByText("Safe Haven QOL")).toBeTruthy();
  });

  it("exposes the workshop id and jar filename in the row's tooltip", () => {
    setup();
    const row = screen.getByText("Safe Haven QOL").closest("li");
    const title = row?.getAttribute("title") ?? "";
    expect(title).toContain("Safe Haven QOL");
    expect(title).toContain("3731244177");
    expect(title).toContain("SafeHavenQOL-1.2.0-2.6.jar");
  });

  it("shows untracked jars labelled as not updatable", () => {
    setup();
    expect(screen.getByText("MysteryMod.jar")).toBeTruthy();
    expect(screen.getByText(/untracked/i)).toBeTruthy();
  });

  it("explains in the tooltip why an untracked jar cannot be updated", () => {
    setup();
    const row = screen.getByText("MysteryMod.jar").closest("li");
    expect(row?.getAttribute("title")).toMatch(/no workshop id/i);
  });

  it("adds a mod from the id and name inputs", async () => {
    const props = setup();
    await userEvent.type(screen.getByLabelText(/mod id/i), "3603448084");
    await userEvent.type(screen.getByLabelText(/mod name/i), "Admin Tools");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(props.onAdd).toHaveBeenCalledWith("3603448084", "Admin Tools");
  });

  it("refuses to add a non-numeric id without calling the daemon", async () => {
    const props = setup();
    await userEvent.type(screen.getByLabelText(/mod id/i), "abc");
    await userEvent.type(screen.getByLabelText(/mod name/i), "X");
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled();
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it("removes a mod by its X button", async () => {
    const props = setup();
    await userEvent.click(screen.getByRole("button", { name: /remove Safe Haven QOL/i }));
    expect(props.onRemove).toHaveBeenCalledWith("3731244177");
  });

  it("disables every mutation while the server is running and says why", () => {
    setup({ running: true });
    expect(screen.getByRole("button", { name: /update all/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled();
    expect(screen.getByText(/stop the server to change mods/i)).toBeTruthy();
  });

  it("disables every mutation while a task is busy, with a reason, even if not running", () => {
    setup({ busy: true, running: false });
    expect(screen.getByRole("button", { name: /update all/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /remove Safe Haven QOL/i })).toBeDisabled();
    expect(screen.getByText(/task.*progress|already running/i)).toBeTruthy();
  });
});

describe("ModsPanel update badges", () => {
  it("badges a mod whose workshop entry changed after it was installed", () => {
    setup({ updates: updateAvailable });
    expect(screen.getByText(/may be newer/i)).toBeTruthy();
  });

  it("words the badge as a possibility, never as a promised new version", () => {
    setup({ updates: updateAvailable });
    // Steam moves time_updated for a description tweak too, so the UI must not
    // claim a new jar exists.
    const badge = screen.getByText(/may be newer/i);
    expect(badge.getAttribute("title")).toMatch(/may be a new version|only an edit/i);
    expect(screen.queryByText(/new version available/i)).toBeNull();
  });

  it("shows no badge when the entry has not changed", () => {
    setup({ updates: [{ ...updateAvailable[0], updateAvailable: false }] });
    expect(screen.queryByText(/may be newer/i)).toBeNull();
  });

  it("still lists every mod when the update check is unavailable", () => {
    // Steam being down costs badges, never the mod list - that separation is
    // the entire reason /api/mods/updates is a second call.
    setup({ updates: null, updatesError: "Steam is unreachable" });
    expect(screen.getByText("Safe Haven QOL")).toBeTruthy();
    expect(screen.getByText("MysteryMod.jar")).toBeTruthy();
    expect(screen.queryByText(/may be newer/i)).toBeNull();
    expect(screen.getByText(/update check unavailable/i)).toBeTruthy();
  });

  it("says in the tooltip when Steam has no entry to compare against", () => {
    setup({
      updates: [{ ...updateAvailable[0], onWorkshop: false, updateAvailable: false }],
    });
    const row = screen.getByText("Safe Haven QOL").closest("li");
    expect(row?.getAttribute("title")).toMatch(/no usable entry/i);
  });

  it("keeps the badged row to a single line: name, badge, and nothing else", () => {
    setup({ updates: updateAvailable });
    const row = screen.getByText("Safe Haven QOL").closest("li");
    // The id and jar stay in the tooltip rather than growing the row.
    expect(row?.textContent).not.toContain("3731244177");
    expect(row?.textContent).not.toContain("SafeHavenQOL-1.2.0-2.6.jar");
  });
});

describe("ModsPanel thumbnails and descriptions", () => {
  it("shows the workshop thumbnail on the mod's row", () => {
    setup({ updates: updateAvailable });
    const img = screen.getByText("Safe Haven QOL").closest("li")?.querySelector("img");
    expect(img?.getAttribute("src")).toBe(updateAvailable[0].previewUrl);
    // Decorative - the name is right beside it.
    expect(img?.getAttribute("alt")).toBe("");
  });

  it("puts the description in the row's tooltip, never on the row itself", () => {
    // The user asked twice for a less squished list. A description under every
    // name is exactly what that ruled out.
    setup({ updates: updateAvailable });
    const row = screen.getByText("Safe Haven QOL").closest("li");
    expect(row?.getAttribute("title")).toContain(updateAvailable[0].description);
    expect(row?.textContent).not.toContain(updateAvailable[0].description);
  });

  it("keeps the row one line: the thumbnail is a fixed box beside the name", () => {
    setup({ updates: updateAvailable });
    const row = screen.getByText("Safe Haven QOL").closest("li");
    // X button, thumb, name, badge - and no description or id text.
    expect(row?.textContent).not.toContain("3731244177");
    expect(row?.querySelectorAll("img")).toHaveLength(1);
  });

  it("reserves the thumbnail slot for a mod Steam has no entry for, keeping names aligned", () => {
    setup({
      updates: [{ ...updateAvailable[0], onWorkshop: false, previewUrl: "", description: "" }],
    });
    const row = screen.getByText("Safe Haven QOL").closest("li");
    expect(row?.querySelector("img")).toBeNull();
    expect(row?.querySelector(".mod-thumb-empty")).toBeTruthy();
  });

  it("adds no thumbnail column at all when the update check has not landed", () => {
    // A Steam outage must leave the list exactly as it was before thumbnails
    // existed, not add a column of empty boxes.
    setup({ updates: null });
    const row = screen.getByText("Safe Haven QOL").closest("li");
    expect(row?.querySelector(".mod-thumb")).toBeNull();
    expect(screen.getByText("Safe Haven QOL").closest("ul")?.className).not.toContain("with-thumbs");
  });
});

describe("ModsPanel adding by id alone", () => {
  it("adds with no name at all, leaving the daemon to resolve the title", async () => {
    const props = setup();
    await userEvent.type(screen.getByLabelText(/mod id/i), "3603448084");
    expect(screen.getByRole("button", { name: /^add$/i })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(props.onAdd).toHaveBeenCalledWith("3603448084", undefined);
  });

  it("still refuses a non-numeric id client-side", async () => {
    const props = setup();
    await userEvent.type(screen.getByLabelText(/mod id/i), "abc");
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled();
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it("refuses an empty id even though the name is optional", async () => {
    setup();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled();
  });

  it("tells the user the name may be left empty", () => {
    setup();
    expect(screen.getByText(/leave the name empty/i)).toBeTruthy();
  });
});

describe("ModsPanel workshop search toggle", () => {
  const search = () =>
    Promise.resolve({ ok: true as const, items: [], nextCursor: null, total: 0 });

  it("does not offer search when no search function is supplied", () => {
    setup();
    expect(screen.queryByRole("button", { name: /search workshop/i })).toBeNull();
  });

  it("swaps the mod list for the search view and back", async () => {
    setup({ onSearch: search });
    await userEvent.click(screen.getByRole("button", { name: /search workshop/i }));
    expect(screen.getByLabelText(/search the steam workshop/i)).toBeTruthy();
    expect(screen.queryByText("Safe Haven QOL")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /back to mods/i }));
    expect(screen.getByText("Safe Haven QOL")).toBeTruthy();
  });

  it("marks the toggle as pressed while the search view is showing", async () => {
    setup({ onSearch: search });
    const toggle = screen.getByRole("button", { name: /search workshop/i });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: /back to mods/i }).getAttribute("aria-pressed")).toBe("true");
  });
});
