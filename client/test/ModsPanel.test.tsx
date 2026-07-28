import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModsPanel, type ModsPanelProps } from "../src/ModsPanel";
import type { ModLibraryEntry, WorldModsResponse } from "../src/types";

const mods = {
  managed: [
    { id: "3731244177", name: "Safe Haven QOL", jar: "SafeHavenQOL-1.2.0-2.6.jar", lastUpdated: "2026-07-26T00:00:00.000Z" },
  ],
  untracked: [{ jar: "MysteryMod.jar" }],
};

/*
 * The library, which is what the panel lists and what a world's set is chosen
 * from. Two entries with two different origins on purpose: a workshop mod (the
 * one the mod list also manages, so it keeps its remove button and its update
 * badge) and a hand-placed jar the library adopted, which has no workshop entry
 * and never will.
 */
const safeHaven: ModLibraryEntry = {
  id: "safehaven.qol",
  name: "Safe Haven QOL",
  version: "2.6",
  gameVersion: "1.2.0",
  author: "SafeHaven",
  clientside: false,
  jar: "SafeHavenQOL-1.2.0-2.6.jar",
  file: "SafeHavenQOL-1.2.0-2.6.jar",
  source: { kind: "workshop", workshopId: "3731244177" },
  addedAt: "2026-07-26T00:00:00.000Z",
  sizeBytes: 2048,
  sha256: "a".repeat(64),
  superseded: [],
};

const summoner: ModLibraryEntry = {
  id: "gagadoliano.summonerexpansion",
  name: "Summoner Expansion",
  version: "7.7",
  gameVersion: "1.2.0",
  author: "Gagadoliano",
  clientside: false,
  jar: "SummonerExpansion-1.2.0-7.7.jar",
  file: "SummonerExpansion-1.2.0-7.7.jar",
  source: { kind: "local", how: "adopted" },
  addedAt: "2026-07-26T00:00:00.000Z",
  sizeBytes: 4096,
  sha256: "b".repeat(64),
  superseded: [],
};

const library = [safeHaven, summoner];

const worldMods = (over: Partial<WorldModsResponse> = {}): WorldModsResponse => ({
  ok: true,
  world: "Tulsa",
  modIds: ["safehaven.qol"],
  missing: [],
  configured: true,
  ...over,
});

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

function setup(overrides: Partial<ModsPanelProps> = {}) {
  const props: ModsPanelProps = {
    mods,
    library,
    busy: false,
    running: false,
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onUpdateAll: vi.fn(),
    ...overrides,
  };
  const view = render(<ModsPanel {...props} />);
  return {
    ...props,
    rerender: (next: Partial<ModsPanelProps> = {}) =>
      view.rerender(<ModsPanel {...props} {...next} />),
  };
}

/** The set editor's props, for the tests that are about the set rather than the list. */
function setupSet(overrides: Partial<ModsPanelProps> = {}) {
  return setup({
    world: "Tulsa",
    worldMods: worldMods(),
    onSaveSet: vi.fn(async () => worldMods()),
    ...overrides,
  });
}

const tick = (name: RegExp | string): HTMLInputElement =>
  screen.getByRole("checkbox", { name }) as HTMLInputElement;

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

/*
 * The set checkboxes. The panel lists the LIBRARY - every mod any world could
 * load - and the ticks are one world's set within it, so the two things it must
 * never confuse are "this mod exists here" and "this world loads it".
 */
describe("ModsPanel set checkboxes", () => {
  it("ticks exactly the mods in the selected world's set", () => {
    setupSet();
    expect(tick("Safe Haven QOL").checked).toBe(true);
    expect(tick("Summoner Expansion").checked).toBe(false);
  });

  it("lists a library mod no world has installed, so it can be added to a set", () => {
    // Summoner Expansion is in the library but not in mods.managed: a list built
    // from the mods folder could not offer it at all.
    setupSet();
    expect(screen.getByText("Summoner Expansion")).toBeTruthy();
  });

  it("switches every tick when the header moves to another world", () => {
    const view = setupSet();
    expect(tick("Safe Haven QOL").checked).toBe(true);
    expect(tick("Summoner Expansion").checked).toBe(false);

    view.rerender({
      world: "Jeff and Eli",
      worldMods: worldMods({ world: "Jeff and Eli", modIds: ["gagadoliano.summonerexpansion"] }),
    });

    expect(tick("Safe Haven QOL").checked).toBe(false);
    expect(tick("Summoner Expansion").checked).toBe(true);
    expect(screen.getByText("Jeff and Eli")).toBeTruthy();
  });

  it("drops a half-ticked edit when the world changes, rather than carrying it over", async () => {
    const view = setupSet();
    await userEvent.click(tick("Summoner Expansion"));
    expect(tick("Summoner Expansion").checked).toBe(true);

    view.rerender({
      world: "Jeff and Eli",
      worldMods: worldMods({ world: "Jeff and Eli", modIds: [] }),
    });

    expect(tick("Summoner Expansion").checked).toBe(false);
  });

  /*
   * The window between the header moving to another world and that world's set
   * arriving. The caller is still holding the PREVIOUS world's payload for the
   * length of a GET - which for an unconfigured world unzips every jar in the
   * mods folder - and rendering it under the new world's name is not a cosmetic
   * lag: the ticks would be the old world's, the removal diff would be computed
   * against the old world's baseline, and Save would write them to the NEW
   * world. The payload names the world it describes; that name decides.
   */
  it("shows no set at all while the payload in hand belongs to the previous world", () => {
    const view = setupSet();
    expect(tick("Safe Haven QOL").checked).toBe(true);

    // The world changed; the answer for it has not arrived.
    view.rerender({ world: "Jeff and Eli" });

    expect(screen.getByText(/reading jeff and eli's mod set/i)).toBeTruthy();
    expect(tick("Safe Haven QOL").checked).toBe(false);
    expect(tick("Safe Haven QOL")).toBeDisabled();
    // Nothing to save with, so nothing can be saved to the wrong world.
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  /*
   * The read failure is a second per-world value on the same held path, so it
   * needs the same check. Untagged, it renders the previous world's failure
   * under this world's name - "Could not read Jeff and Eli's mod set: Tulsa.zip
   * is gone" - and, being ahead of the Reading branch, hides the fact that
   * nothing has been read for this world at all.
   */
  it("does not report the previous world's read failure under this world's name", () => {
    const view = setupSet({
      worldMods: null,
      worldModsError: { world: "Tulsa", message: "ENOENT: Tulsa.zip is gone" },
    });
    expect(screen.getByText(/ENOENT: Tulsa\.zip is gone/)).toBeTruthy();

    view.rerender({ world: "Jeff and Eli" });

    expect(screen.queryByText(/ENOENT/)).toBeNull();
    expect(screen.getByText(/reading jeff and eli's mod set/i)).toBeTruthy();
  });

  it("matches the world case-insensitively, exactly as the daemon looks a set up", () => {
    // Asking about "tulsa" legitimately answers "Tulsa": the daemon echoes the
    // name as it was last written. An exact match would read as "still reading"
    // forever and take the checkboxes with it.
    setupSet({ world: "tulsa", worldMods: worldMods({ world: "Tulsa" }) });
    expect(tick("Safe Haven QOL").checked).toBe(true);
    expect(screen.getByRole("button", { name: /save tulsa's mod set/i })).toBeTruthy();
  });

  it("says nothing about a set until a world name is confirmed", () => {
    setup({ onSaveSet: vi.fn() });
    expect(screen.getByText(/type a world name in the header/i)).toBeTruthy();
    expect(tick("Safe Haven QOL")).toBeDisabled();
  });
});

/*
 * A world nobody has chosen a set for is not a world that loads nothing. The
 * daemon reports the difference (`configured`), because an unconfigured world
 * starts by adopting whatever is in the mods folder - so the UI has to report
 * it too, and say what a start would actually load.
 */
describe("ModsPanel unconfigured versus empty", () => {
  it("says an unconfigured world will start with what is in the mods folder", () => {
    setupSet({ worldMods: worldMods({ configured: false, modIds: ["safehaven.qol"] }) });
    expect(screen.getByText(/no mod set has been chosen for tulsa yet/i)).toBeTruthy();
    expect(screen.getByText(/1 mod in the mods folder right now/i)).toBeTruthy();
    expect(screen.queryByText(/loads no mods at all/i)).toBeNull();
    // ...and it is ticked, because that is what would be saved as the set.
    expect(tick("Safe Haven QOL").checked).toBe(true);
  });

  it("says an empty set loads nothing, in different words entirely", () => {
    setupSet({ worldMods: worldMods({ configured: true, modIds: [] }) });
    expect(screen.getByText(/loads no mods at all/i)).toBeTruthy();
    expect(screen.queryByText(/no mod set has been chosen/i)).toBeNull();
    expect(tick("Safe Haven QOL").checked).toBe(false);
  });

  it("gives a set's missing mod a row of its own so it can be unticked", () => {
    // Without a row there is no way out of an unstartable world: the mod is in
    // the set, the library has no jar for it, and the daemon refuses to start.
    setupSet({
      worldMods: worldMods({ modIds: ["safehaven.qol", "gone.mod"], missing: ["gone.mod"] }),
    });
    expect(screen.getByText(/library has no jar for gone\.mod/i)).toBeTruthy();
    expect(screen.getByText(/will not start/i)).toBeTruthy();
    expect(tick("gone.mod").checked).toBe(true);
    expect(screen.getByText(/^missing$/i)).toBeTruthy();
  });

  /*
   * The same field means something different for a world with no set. There the
   * daemon derives the ids from the mods folder and diffs them against the
   * library, so a hand-placed jar is "missing" having never been in the library -
   * while reconcile adopts every folder jar into the library at step 2, before it
   * resolves the set at step 3. That world starts fine, and saying it will not is
   * a false alarm about the one thing this panel has to be trusted on.
   */
  it("does not claim an unconfigured world will fail to start over a jar it will adopt", () => {
    setupSet({
      worldMods: worldMods({
        configured: false,
        modIds: ["safehaven.qol", "hand.dropped"],
        missing: ["hand.dropped"],
      }),
    });
    expect(screen.queryByText(/will not start/i)).toBeNull();
    expect(screen.getByText(/starting tulsa takes it in/i)).toBeTruthy();
    // Still listed, and still untickable before it becomes the set.
    expect(tick("hand.dropped").checked).toBe(true);
  });
});

describe("ModsPanel changing a set", () => {
  it("saves the ticked ids and reports what the world will load next start", async () => {
    const props = setupSet({
      onSaveSet: vi.fn(async () =>
        worldMods({ modIds: ["safehaven.qol", "gagadoliano.summonerexpansion"] }),
      ),
    });
    await userEvent.click(tick("Summoner Expansion"));
    await userEvent.click(screen.getByRole("button", { name: /save tulsa's mod set/i }));

    expect(props.onSaveSet).toHaveBeenCalledWith([
      "safehaven.qol",
      "gagadoliano.summonerexpansion",
    ]);
    expect(await screen.findByText(/loads 2 mods at its next start/i)).toBeTruthy();
  });

  it("has nothing to save until something is ticked", () => {
    setupSet();
    expect(screen.getByRole("button", { name: /save tulsa's mod set/i })).toBeDisabled();
  });

  it("puts a ticked change back with Revert", async () => {
    const props = setupSet();
    await userEvent.click(tick("Summoner Expansion"));
    await userEvent.click(screen.getByRole("button", { name: /^revert$/i }));
    expect(tick("Summoner Expansion").checked).toBe(false);
    expect(props.onSaveSet).not.toHaveBeenCalled();
  });

  it("shows the daemon's own refusal, not a reworded one", async () => {
    const message =
      "The library has no jar for gone.mod. A set may only name mods the library holds.";
    setupSet({ onSaveSet: vi.fn(async () => Promise.reject(new Error(message))) });
    await userEvent.click(tick("Summoner Expansion"));
    await userEvent.click(screen.getByRole("button", { name: /save tulsa's mod set/i }));
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it("keeps a refusal with the world it was a save of, when the header has moved on", async () => {
    // The success message names its own world in its text; the daemon's refusal
    // does not, so it has to carry the tag instead.
    let fail: (e: Error) => void = () => {};
    const onSaveSet = vi.fn(
      () => new Promise<WorldModsResponse>((_resolve, reject) => (fail = reject)),
    );
    const view = setupSet({ onSaveSet });
    await userEvent.click(tick("Summoner Expansion"));
    await userEvent.click(screen.getByRole("button", { name: /save tulsa's mod set/i }));

    view.rerender({
      world: "Jeff and Eli",
      worldMods: worldMods({ world: "Jeff and Eli", modIds: [] }),
    });
    await act(async () => {
      fail(new Error("The library has no jar for gone.mod."));
    });

    expect(screen.queryByText(/no jar for gone\.mod/)).toBeNull();
  });

  it("drops that refusal the moment the ticks change, since it described the old ones", async () => {
    const message = "The library has no jar for gone.mod.";
    setupSet({ onSaveSet: vi.fn(async () => Promise.reject(new Error(message))) });
    await userEvent.click(tick("Summoner Expansion"));
    await userEvent.click(screen.getByRole("button", { name: /save tulsa's mod set/i }));
    expect(await screen.findByText(message)).toBeTruthy();

    await userEvent.click(tick("Summoner Expansion"));

    expect(screen.queryByText(message)).toBeNull();
  });
});

/*
 * A mod mods.json still manages that the library has no jar for - an install
 * recorded before the library existed, or one whose entry went. It gets no set
 * row, so without a row of its own it would have no Remove button either and
 * there would be no way to clear it from the UI at all.
 */
describe("ModsPanel a managed mod the library lost", () => {
  const ghost = {
    id: "999",
    name: "Ghost Mod",
    jar: "Ghost.jar",
    lastUpdated: "2026-07-26T00:00:00.000Z",
  };

  it("still lists it, and still lets it be removed", async () => {
    const props = setup({ mods: { managed: [...mods.managed, ghost], untracked: [] } });
    expect(screen.getByText("Ghost Mod")).toBeTruthy();
    expect(screen.getByText(/not in library/i)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /remove ghost mod/i }));

    expect(props.onRemove).toHaveBeenCalledWith("999");
  });

  it("gives it no checkbox, because no set can name it", () => {
    setup({ mods: { managed: [...mods.managed, ghost], untracked: [] } });
    expect(screen.queryByRole("checkbox", { name: "Ghost Mod" })).toBeNull();
  });
});

describe("ModsPanel with an unreadable library", () => {
  const LIBRARY_ERROR =
    "The mod library could not be read (404 Not Found). Per-world mod sets, the library list " +
    "and jar upload are unavailable until it can be; everything else here still works.";

  it("says what is wrong instead of showing an empty library", () => {
    setup({ library: [], libraryError: LIBRARY_ERROR, world: "Tulsa" });
    expect(screen.getByText(new RegExp("mod library could not be read"))).toBeTruthy();
    expect(screen.queryByText(/type a world name in the header/i)).toBeNull();
  });

  it("keeps the mod list and its Remove buttons, which do not need the library", () => {
    setup({ library: [], libraryError: LIBRARY_ERROR });
    expect(screen.getByText("Safe Haven QOL")).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove safe haven qol/i })).toBeEnabled();
  });
});

/*
 * Removing a mod from a world whose save already has its content in it is a
 * genuine way to lose that save. The decision is the operator's - this must not
 * block - but it must not be soft about what it is either.
 */
describe("ModsPanel removal warning", () => {
  it("warns, in full, the moment a mod is unticked out of a saved set", async () => {
    setupSet();
    expect(screen.queryByRole("alert")).toBeNull();

    await userEvent.click(tick("Safe Haven QOL"));

    const warning = screen.getByRole("alert");
    expect(warning.textContent).toMatch(/can corrupt that save/i);
    expect(warning.textContent).toMatch(/Safe Haven QOL/);
    expect(warning.textContent).toMatch(/fail to load/i);
  });

  it("allows the removal anyway", async () => {
    const props = setupSet();
    await userEvent.click(tick("Safe Haven QOL"));
    const save = screen.getByRole("button", { name: /save tulsa's mod set/i });
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(props.onSaveSet).toHaveBeenCalledWith([]);
  });

  it("does not warn when a mod is only being added", async () => {
    setupSet();
    await userEvent.click(tick("Summoner Expansion"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

/*
 * The set is a mod mutation like any other: the game reads its mods once, at
 * startup, so changing what a running world loads produces an edit that did
 * nothing. Gated on the same two conditions as every other mutation here, with
 * the same sentence the panel already shows for them.
 */
describe("ModsPanel set gating", () => {
  it("refuses a set change while the server is running, with the reason visible", async () => {
    const props = setupSet({ running: true });
    expect(screen.getByText(/stop the server to change mods/i)).toBeTruthy();
    const box = tick("Safe Haven QOL");
    expect(box).toBeDisabled();
    expect(box.getAttribute("title")).toMatch(/stop the server to change mods/i);
    expect(screen.getByRole("button", { name: /save tulsa's mod set/i })).toBeDisabled();

    await userEvent.click(box);
    expect(box.checked).toBe(true);
    expect(props.onSaveSet).not.toHaveBeenCalled();
  });

  it("refuses a set change while a task is in flight, with the reason visible", () => {
    setupSet({ busy: true });
    expect(screen.getByText(/already running/i)).toBeTruthy();
    expect(tick("Safe Haven QOL")).toBeDisabled();
    expect(tick("Safe Haven QOL").getAttribute("title")).toMatch(/already running/i);
    expect(screen.getByRole("button", { name: /save tulsa's mod set/i })).toBeDisabled();
  });
});

describe("ModsPanel uploading a jar", () => {
  const jar = () => new File(["not really a jar"], "SummonerExpansion-1.2.0-7.7.jar");

  const uploadResponse = {
    ok: true as const,
    mod: { ...summoner, version: "7.8" },
    replaced: false,
  };

  it("sends the picked file and says what landed in the library", async () => {
    const onUpload = vi.fn(async () => uploadResponse);
    setupSet({ onUpload });

    await userEvent.upload(screen.getByLabelText(/mod jar/i), jar());
    await userEvent.click(screen.getByRole("button", { name: /^upload$/i }));

    expect(onUpload).toHaveBeenCalledTimes(1);
    expect((onUpload.mock.calls[0] as unknown as File[])[0].name).toBe(
      "SummonerExpansion-1.2.0-7.7.jar",
    );
    expect(await screen.findByText(/Summoner Expansion 7\.8 is in the library/)).toBeTruthy();
  });

  it("shows the daemon's rejection verbatim, because it says exactly what is wrong", async () => {
    // The daemon's own words for a file that is not a Necesse mod.
    const message =
      "NotAMod.jar contains no mod.info at its root, so it is not a Necesse mod jar. Entries seen: 2.";
    setupSet({ onUpload: vi.fn(async () => Promise.reject(new Error(message))) });

    await userEvent.upload(screen.getByLabelText(/mod jar/i), jar());
    await userEvent.click(screen.getByRole("button", { name: /^upload$/i }));

    expect(await screen.findByText(message)).toBeTruthy();
  });

  it("holds the picker and the button while the bytes are on the wire", async () => {
    // A 100MB jar is not instant, and a second click would send it twice.
    let release: (r: typeof uploadResponse) => void = () => {};
    const onUpload = vi.fn(() => new Promise<typeof uploadResponse>((r) => (release = r)));
    setupSet({ onUpload });

    const picker = screen.getByLabelText(/mod jar/i);
    await userEvent.upload(picker, jar());
    await userEvent.click(screen.getByRole("button", { name: /^upload$/i }));

    expect(picker).toBeDisabled();
    expect(screen.getByRole("button", { name: /uploading/i })).toBeDisabled();
    expect(screen.getByRole("progressbar", { name: /uploading/i })).toBeTruthy();

    release(uploadResponse);
    expect(await screen.findByText(/is in the library/)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("has nothing to upload until a file is picked", () => {
    setupSet({ onUpload: vi.fn() });
    expect(screen.getByRole("button", { name: /^upload$/i })).toBeDisabled();
  });

  it("stays available while the server is running, since it only fills the library", () => {
    setupSet({ onUpload: vi.fn(), running: true });
    expect(screen.getByLabelText(/mod jar/i)).toBeEnabled();
  });

  it("waits for a task in flight, which does touch the library", () => {
    setupSet({ onUpload: vi.fn(), busy: true });
    expect(screen.getByLabelText(/mod jar/i)).toBeDisabled();
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
