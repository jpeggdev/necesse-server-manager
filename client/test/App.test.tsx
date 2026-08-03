// Drives the whole App against a fake daemon to pin the one property neither
// the hook nor the header can prove alone: `busy` is continuous from the
// moment a task-launching button is clicked until the daemon says the task is
// done, with no gap where Start/Update Server re-enable while steamcmd is
// already rewriting the install.
//
// The two spans that make it up are owned by different things - App's local
// `submitting` counter covers click-to-response, the daemon's `activeTasks`
// covers the rest - so the only way to show they overlap rather than abut is
// to hold the launching response open and step through it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent, cleanup } from "@testing-library/react";
import App from "../src/App";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send() {
    // no-op
  }
  close() {
    this.onclose?.();
  }
}

let activeTasks: string[] = [];
/** What the daemon currently reports; mutable so a test can move it. */
let serverState = "stopped";
/** Holds POST /api/server/update open so the click-to-response span is observable. */
let releaseUpdate: (() => void) | null = null;
/** How POST /api/server/stop answers. Null means "not exercised in this test". */
let stopResponse: { ok: boolean; status: number; body: unknown } | null = null;
/** How POST /api/mods answers. Null means "not exercised in this test". */
let addModResponse: { ok: boolean; status: number; body: unknown } | null = null;
/** The raw JSON body of the last POST /api/mods, so the name-optional wiring is checkable end to end. */
let lastAddBody: string | null = null;
/** The raw JSON body of the last PUT of a world's settings, for the same reason. */
let lastSettingsBody: string | null = null;
/** The raw JSON body of the last PUT of a world's mod set. */
let lastSetBody: string | null = null;
/** What each world's set is, keyed by world name. A world absent from it has none. */
let worldSets: Record<string, { modIds: string[]; missing: string[]; configured: boolean }> = {};
/** The world whose set GET is held open, so the swap window is observable. */
let holdWorldMods: string | null = null;
let releaseWorldMods: (() => void) | null = null;
/** False for a daemon too old to have GET /api/mods/library. */
let libraryEndpointExists = true;
/** Non-fatal daemon configuration problems, e.g. a missing steamcmd. */
let configWarnings: string[] = [];
/** True for a daemon that 401s everything, i.e. one holding a different token. */
let tokenRejected = false;

/*
 * The mod library the daemon holds. Two origins, because the panel treats them
 * differently: a workshop mod carries an id to update from, a hand-placed jar
 * the library adopted never will.
 */
const libraryMods = [
  {
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
  },
  {
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
  },
];

const SETTINGS_BACKUP = "C:/worlds/Tulsa.zip.2026-07-27T05-01-02-003Z.bak";

function settingsFields(allowCheats: string) {
  return [
    { key: "allowCheats", value: allowCheats, type: "boolean", editable: true },
    {
      key: "difficulty",
      value: "CLASSIC",
      type: "enum",
      options: ["CASUAL", "CLASSIC", "BRUTAL"],
      editable: true,
    },
    { key: "gameVersion", value: "1.2.0", type: "string", editable: false },
    { key: "rpgskillsWorldStackLevel", value: "1", type: null, editable: false },
  ];
}

function statusPayload() {
  return {
    state: serverState,
    world: null,
    pid: null,
    startedAt: null,
    port: null,
    slots: null,
    gameVersion: null,
    lastError: null,
    activeTasks: [...activeTasks],
    configWarnings: [...configWarnings],
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  // Cleared, not just overwritten: the console toggle and the two pane widths
  // persist, so without this one test's layout would leak into the next.
  localStorage.clear();
  localStorage.setItem(
    "necesse.connection",
    JSON.stringify({ host: "127.0.0.1", port: 8710, token: "" }),
  );
  activeTasks = [];
  serverState = "stopped";
  releaseUpdate = null;
  stopResponse = null;
  addModResponse = null;
  lastAddBody = null;
  lastSettingsBody = null;
  lastSetBody = null;
  holdWorldMods = null;
  releaseWorldMods = null;
  libraryEndpointExists = true;
  configWarnings = [];
  tokenRejected = false;
  worldSets = {
    Tulsa: { modIds: ["safehaven.qol"], missing: [], configured: true },
    "Jeff and Eli": { modIds: ["gagadoliano.summonerexpansion"], missing: [], configured: true },
  };
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      // Before every route, the way the daemon's own auth hook sits ahead of
      // every route: a wrong token fails the whole API, not one endpoint.
      if (tokenRejected) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({ error: "This daemon requires an access token." }),
        };
      }
      // Keyed on the verb, not the path: GET /api/mods (the list) and
      // POST /api/mods (the add) are the same url.
      if (url.endsWith("/api/mods") && init?.method === "POST") {
        lastAddBody = init.body ?? null;
        if (addModResponse) {
          return { ok: addModResponse.ok, status: addModResponse.status, json: async () => addModResponse!.body };
        }
        return jsonResponse({ ok: true, taskId: "t1" });
      }
      if (url.endsWith("/api/server/stop") && stopResponse) {
        return { ok: stopResponse.ok, status: stopResponse.status, json: async () => stopResponse!.body };
      }
      if (url.endsWith("/api/server/update")) {
        return new Promise((resolve) => {
          releaseUpdate = () => resolve(jsonResponse({ ok: true, taskId: "t1" }));
        });
      }
      if (url.endsWith("/api/status")) return jsonResponse(statusPayload());
      if (url.includes("/settings")) {
        if (init?.method === "PUT") {
          lastSettingsBody = init.body ?? null;
          return jsonResponse({
            ok: true,
            world: "Tulsa",
            entry: "Tulsa/worldSettings.cfg",
            fields: settingsFields("true"),
            backup: SETTINGS_BACKUP,
            changed: ["allowCheats"],
          });
        }
        return jsonResponse({
          ok: true,
          world: "Tulsa",
          entry: "Tulsa/worldSettings.cfg",
          fields: settingsFields("false"),
        });
      }
      if (url.endsWith("/api/mods/library")) {
        return libraryEndpointExists
          ? jsonResponse({ ok: true, mods: libraryMods })
          : {
              ok: false,
              status: 404,
              statusText: "Not Found",
              json: async () => ({ message: "Route GET:/api/mods/library not found" }),
            };
      }
      // Matched before the world list below, which would otherwise swallow it:
      // /api/worlds/Tulsa/mods and /api/worlds are the same prefix.
      const setUrl = /\/api\/worlds\/([^/]+)\/mods$/.exec(url);
      if (setUrl) {
        const name = decodeURIComponent(setUrl[1]);
        if (init?.method === "PUT") {
          lastSetBody = init.body ?? null;
          const modIds = (JSON.parse(init.body ?? "{}") as { modIds: string[] }).modIds;
          worldSets[name] = { modIds, missing: [], configured: true };
        }
        const set = worldSets[name] ?? { modIds: [], missing: [], configured: false };
        const body = { ok: true, world: name, ...set };
        // Held open so a test can stand inside the window between the header
        // moving to another world and that world's set arriving.
        if (holdWorldMods === name && init?.method !== "PUT") {
          return new Promise((resolve) => {
            releaseWorldMods = () => resolve(jsonResponse(body));
          });
        }
        return jsonResponse(body);
      }
      if (url.includes("/api/worlds")) {
        // The candidate is echoed back for whatever name was asked about, so
        // the header's real staleness gate runs instead of being bypassed.
        const asked = /[?&]name=([^&]*)/.exec(url);
        const name = asked === null ? null : decodeURIComponent(asked[1]);
        return jsonResponse({
          worlds: [],
          lastWorld: "Tulsa",
          candidate: name === null ? null : { name, valid: true, exists: name === "Tulsa" },
        });
      }
      if (url.endsWith("/api/mods")) return jsonResponse({ managed: [], untracked: [] });
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountConnected() {
  render(<App />);
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  await act(async () => {
    ws.onopen?.();
  });
  await screen.findByRole("button", { name: /update server/i });
  return ws;
}

/** Lets every queued microtask and the follow-up refresh() settle. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("App players tab", () => {
  it("shows the roster the daemon pushed, without losing the mods panel", async () => {
    const ws = await mountConnected();
    await act(async () => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "players",
          players: [
            {
              auth: "76561198048435182",
              name: "Jeff",
              slot: 1,
              latency: 42,
              level: "surface",
              joinedAt: null,
            },
          ],
        }),
      });
    });

    // The count is visible from the Mods tab, so the operator sees somebody
    // join without having to be looking at the right panel.
    const tab = await screen.findByRole("tab", { name: /players \(1\)/i });
    fireEvent.click(tab);
    expect(await screen.findByText("Jeff")).toBeInTheDocument();

    // Switching back must not have thrown away the mods panel's own state.
    fireEvent.click(screen.getByRole("tab", { name: /^mods$/i }));
    expect(screen.getByRole("heading", { name: /^mods$/i })).toBeVisible();
  });
});

describe("App console toggle", () => {
  const toggle = () => screen.getByRole("button", { name: /^console$/i });

  it("starts with the console up and Mods and Players sharing the left column as tabs", async () => {
    await mountConnected();
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tab", { name: /^mods$/i })).toBeInTheDocument();
    expect(screen.getByRole("separator")).toHaveAccessibleName("Resize mods panel");
  });

  it("hides the console and puts both panels on screen at once", async () => {
    await mountConnected();
    fireEvent.click(toggle());

    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    // The tabs are gone because there is nothing left to arbitrate...
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    // ...and both panels are visible together, which is the whole point.
    expect(screen.getByRole("heading", { name: /^mods$/i })).toBeVisible();
    expect(screen.getByRole("heading", { name: /^players \(\d+\)$/i })).toBeVisible();
    // The splitter now sizes the players pane, so it must say so.
    expect(screen.getByRole("separator")).toHaveAccessibleName("Resize players panel");
  });

  it("puts the console back, with the tabs, when toggled again", async () => {
    await mountConnected();
    fireEvent.click(toggle());
    fireEvent.click(toggle());

    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tab", { name: /^mods$/i })).toBeInTheDocument();
    expect(screen.getByRole("separator")).toHaveAccessibleName("Resize mods panel");
  });

  it("keeps the mods panel's unsaved state across the toggle, rather than remounting it", async () => {
    const ws = await mountConnected();
    await settle();

    // Untick a mod so the panel is holding an edit that only exists in its own
    // state - a remount is exactly what would silently discard it.
    const tick = await screen.findByRole("checkbox", { name: /safe haven qol/i });
    await waitFor(() => expect(tick).toBeChecked());
    fireEvent.click(tick);
    expect(tick).not.toBeChecked();

    fireEvent.click(toggle());
    await settle();

    // The layout genuinely changed. Without this the assertion below would hold
    // trivially for a toggle that did nothing at all.
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^mods$/i })).toBeVisible();

    // Still unticked after changing columns. The naive implementation - moving
    // ModsPanel to a different parent - remounts it, which reloads the saved
    // set and silently re-ticks this box.
    expect(screen.getByRole("checkbox", { name: /safe haven qol/i })).not.toBeChecked();
    // And the app around it did not remount either.
    expect(ws).toBe(FakeWebSocket.instances[FakeWebSocket.instances.length - 1]);
  });

  it("remembers the choice for the next launch", async () => {
    await mountConnected();
    fireEvent.click(toggle());
    expect(localStorage.getItem("necesse.consoleVisible")).toBe("false");

    cleanup();
    await mountConnected();
    expect(screen.getByRole("button", { name: /^console$/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("sizes each layout's left pane from its own remembered width", async () => {
    localStorage.setItem("necesse.modsWidth", "500");
    localStorage.setItem("necesse.playersWidth", "260");
    await mountConnected();

    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "500");
    fireEvent.click(toggle());
    // Not 500: dragging the mods pane wide must not widen the players table.
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "260");
  });
});

describe("App busy continuity", () => {
  it("keeps the task buttons disabled from click, through the response, until the daemon reports the task done", async () => {
    const ws = await mountConnected();
    const updateServer = screen.getByRole("button", { name: /update server/i });
    expect(updateServer).toBeEnabled();

    // 1. Clicked, response still outstanding. Only `submitting` can cover this.
    fireEvent.click(updateServer);
    expect(updateServer).toBeDisabled();
    expect(screen.getByRole("button", { name: /update all/i })).toBeDisabled();

    // 2. The daemon accepted the task before it answered, so the refresh()
    //    that runs as the response lands already sees it in activeTasks.
    activeTasks = ["t1"];
    await act(async () => {
      releaseUpdate?.();
    });
    await settle();
    expect(updateServer).toBeDisabled();

    // 3. Still disabled with no further traffic at all - the task is running.
    await settle();
    expect(updateServer).toBeDisabled();

    // 4. The daemon says it is done; the UI re-enables off that, nothing else.
    activeTasks = [];
    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "status", status: statusPayload() }) });
    });
    await waitFor(() => expect(updateServer).toBeEnabled());
  });

  it("re-enables after a task whose response resolves but which the daemon never reports as active", async () => {
    // The fast-failing case seen end to end: the task finished before the
    // launching response even landed, so activeTasks is already empty by the
    // time the client reads it. Nothing may stay disabled.
    const ws = await mountConnected();
    const updateServer = screen.getByRole("button", { name: /update server/i });

    fireEvent.click(updateServer);
    expect(updateServer).toBeDisabled();

    await act(async () => {
      releaseUpdate?.();
    });
    await settle();

    // activeTasks was never non-empty; the button must come straight back.
    await waitFor(() => expect(updateServer).toBeEnabled());

    // A late task-done for that id changes nothing.
    await act(async () => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "task-done", taskId: "t1", kind: "server-update", ok: false, error: "boom" }),
      });
    });
    await settle();
    expect(updateServer).toBeEnabled();
  });
});

/*
 * The daemon's stop-timeout behaviour is correct on its own - it waits, gives
 * up, answers 504, and leaves the process alive on purpose - but the operator
 * only ever sees the client. Pre-fix the 504 produced an error banner saying
 * "the process was left running" above a header with a disabled Stop, no
 * Start, and no kill: nothing to act with. This pins the whole path, from the
 * HTTP status through to a usable button.
 */
describe("App stop timeout", () => {
  const TIMEOUT_MESSAGE =
    "Server did not exit within 90000ms of receiving stop. It may still be saving. The process was left running.";

  it("surfaces Force kill after a 504 stop, and withdraws it once the server is gone", async () => {
    serverState = "running";
    stopResponse = { ok: false, status: 504, body: { ok: false, error: TIMEOUT_MESSAGE } };
    const ws = await mountConnected();

    expect(screen.queryByRole("button", { name: /force kill/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));

    // The daemon set `stopping` before writing to stdin, then timed out.
    serverState = "stopping";
    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "status", status: statusPayload() }) });
    });
    await settle();

    expect(screen.getByText(TIMEOUT_MESSAGE)).toBeTruthy();
    const kill = await screen.findByRole("button", { name: /force kill/i });
    expect(kill).toBeEnabled();

    // The server finishes saving and exits on its own: the dangerous button
    // must not linger into the next lifecycle.
    serverState = "stopped";
    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "status", status: statusPayload() }) });
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /force kill/i })).toBeNull());
  });

  it("does not surface Force kill when a stop fails for any other reason", async () => {
    // A 409 ("not running") is a mistake, not a stuck process. Only the
    // timeout leaves the operator without a control.
    serverState = "running";
    stopResponse = { ok: false, status: 409, body: { ok: false, error: "Server is not running (state: stopped)." } };
    const ws = await mountConnected();

    fireEvent.click(screen.getByRole("button", { name: /^stop$/i }));
    serverState = "stopping";
    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "status", status: statusPayload() }) });
    });
    await settle();

    expect(screen.getByText(/not running/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /force kill/i })).toBeNull();
  });
});

/*
 * Adding by id alone only works if the whole chain holds: the panel lets an
 * empty name through, api.addMod omits the key rather than sending "", and the
 * daemon's 400 - the one case where the user MUST supply a name - reaches the
 * banner instead of being swallowed into a silent no-op. A user who cannot see
 * that message has no way to know what to do next.
 */
/*
 * The world settings editor only works if the whole chain holds: the header's
 * candidate gate has to open the button for a world that exists, the dialog
 * has to load that world's own file, and the save has to carry ONLY what
 * changed. A form that posted every field would rewrite lines nobody touched -
 * in a zip that is the single copy of somebody's save.
 */
describe("App world settings editor", () => {
  async function openEditor() {
    await mountConnected();
    const trigger = await screen.findByRole("button", { name: /world settings/i });
    await waitFor(() => expect(trigger).toBeEnabled());
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    return trigger;
  }

  it("opens on the world in the header and sends only the field that changed", async () => {
    await openEditor();
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/tulsa/i);

    fireEvent.click(screen.getByLabelText("allowCheats"));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await settle();

    expect(JSON.parse(lastSettingsBody!)).toEqual({ allowCheats: true });
    expect(screen.getByText(new RegExp(SETTINGS_BACKUP))).toBeTruthy();
  });

  it("stays shut, with a reason, while the server is running", async () => {
    serverState = "running";
    await mountConnected();
    const trigger = await screen.findByRole("button", { name: /world settings/i });
    expect(trigger).toBeDisabled();
    expect(trigger.getAttribute("title")).toMatch(/stopped/i);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/*
 * The set checkboxes across the whole seam: the header's world field, the
 * daemon's answer about that name, the world's set, and the ticks. Nothing
 * shorter than the App can show it, because the world lives in the header and
 * the ticks live in the panel, and the thing that has to hold is that they
 * describe the same world at the same moment.
 */
describe("App per-world mod sets", () => {
  const tick = (name: string) => screen.getByRole("checkbox", { name });

  it("ticks the header world's set, and re-ticks the whole list when the world changes", async () => {
    await mountConnected();

    await waitFor(() => expect(tick("Safe Haven QOL")).toBeChecked());
    expect(tick("Summoner Expansion")).not.toBeChecked();

    fireEvent.change(screen.getByLabelText("World"), { target: { value: "Jeff and Eli" } });

    await waitFor(() => expect(tick("Summoner Expansion")).toBeChecked());
    expect(tick("Safe Haven QOL")).not.toBeChecked();
  });

  it("PUTs exactly the ids the panel has ticked", async () => {
    await mountConnected();
    await waitFor(() => expect(tick("Safe Haven QOL")).toBeChecked());

    fireEvent.click(tick("Summoner Expansion"));
    fireEvent.click(screen.getByRole("button", { name: /save tulsa's mod set/i }));
    await settle();

    expect(JSON.parse(lastSetBody!)).toEqual({
      modIds: ["safehaven.qol", "gagadoliano.summonerexpansion"],
    });
  });

  /*
   * The failure this test exists for was reproduced, not imagined: with the
   * previous world's payload still in hand, the panel rendered "Mods for Jeff
   * and Eli" with TULSA's mod ticked, and Save wrote Tulsa's set to Jeff and
   * Eli. The window is a whole GET - which for an unconfigured world unzips
   * every jar in the mods folder - so it is not narrow, and a test that lets the
   * read land before looking (waitFor, or an atomic rerender) steps clean over
   * it. This one stands inside it.
   */
  it("shows no set, and offers no save, while the new world's read is still out", async () => {
    await mountConnected();
    await waitFor(() => expect(tick("Safe Haven QOL")).toBeChecked());

    holdWorldMods = "Jeff and Eli";
    fireEvent.change(screen.getByLabelText("World"), { target: { value: "Jeff and Eli" } });

    // The header confirms the new name long before the set for it arrives.
    expect(await screen.findByText(/reading jeff and eli's mod set/i)).toBeTruthy();
    expect(tick("Safe Haven QOL")).not.toBeChecked();
    expect(tick("Safe Haven QOL")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /save jeff and eli's mod set/i })).toBeNull();
    expect(lastSetBody).toBeNull();

    await act(async () => {
      releaseWorldMods?.();
    });

    await waitFor(() => expect(tick("Summoner Expansion")).toBeChecked());
    expect(tick("Safe Haven QOL")).not.toBeChecked();
  });

  it("distinguishes a world with no set from a world with an empty one", async () => {
    // A world nobody has chosen a set for: the daemon answers configured:false,
    // and the panel has to say what a start would load rather than "no mods".
    await mountConnected();
    fireEvent.change(screen.getByLabelText("World"), { target: { value: "Ranch" } });

    expect(await screen.findByText(/no mod set has been chosen for ranch yet/i)).toBeTruthy();
    expect(screen.queryByText(/loads no mods at all/i)).toBeNull();
  });
});

/*
 * GET /api/mods/library is the newest route in the API, so it is the one a
 * daemon that has not been updated yet does not have. Folded into refresh()'s
 * Promise.all it took the status, the world list and the mod list down with it,
 * and the app sat on "Connecting to the daemon" - no console, no Stop button -
 * while people were on the server. It must cost the set features and nothing
 * else.
 */
describe("App against a daemon with no mod library", () => {
  it("keeps the whole app working and says what is unavailable", async () => {
    libraryEndpointExists = false;
    await mountConnected();

    expect(screen.queryByText(/connecting to the daemon/i)).toBeNull();
    expect(screen.getByRole("button", { name: /update server/i })).toBeEnabled();
    expect(await screen.findByText(/mod library could not be read/i)).toBeTruthy();
    // No ticks to offer, and nothing that could write a set through a library
    // this daemon does not have.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /save .* mod set/i })).toBeNull();
  });

  it("does not raise the daemon-connectivity banner over it", async () => {
    // The banner means "the daemon is unreachable". It is not: everything else
    // just answered.
    libraryEndpointExists = false;
    await mountConnected();
    await settle();
    expect(screen.queryByText(/^404/)).toBeNull();
    expect(screen.getByRole("button", { name: /^stop$|^start$/i })).toBeTruthy();
  });
});

/*
 * Non-fatal daemon-side configuration problems (currently only a missing
 * steamcmd) travel on every status payload so the operator sees them before
 * they discover one by trying to install a mod.
 */
describe("App config warnings", () => {
  it("surfaces a warning the daemon reports", async () => {
    configWarnings = ["steamcmd.exe was not found; mod installs and updates will fail."];
    await mountConnected();
    expect(await screen.findByText(/steamcmd\.exe was not found/i)).toBeTruthy();
  });

  it("shows two warnings that happen to say the same thing", async () => {
    configWarnings = ["duplicate warning", "duplicate warning"];
    await mountConnected();
    expect(await screen.findAllByText("duplicate warning")).toHaveLength(2);
  });
});

describe("App adding a mod by id alone", () => {
  async function addById(id: string) {
    await mountConnected();
    const idBox = screen.getByLabelText(/mod id/i);
    fireEvent.change(idBox, { target: { value: id } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await settle();
  }

  it("posts the id with no name at all, leaving the title to Steam", async () => {
    await addById("3603448084");
    expect(JSON.parse(lastAddBody!)).toEqual({ id: "3603448084" });
  });

  it("shows the daemon's own message when Steam cannot resolve a name", async () => {
    const message =
      "Steam returned no title for 3603448084. Supply a name explicitly and try again.";
    addModResponse = { ok: false, status: 400, body: { ok: false, error: message } };
    await addById("3603448084");
    expect(screen.getByText(message)).toBeTruthy();
  });
});

describe("App when the daemon rejects the token", () => {
  /**
   * The app leaves the connected view on a 401 and lands on the connection
   * screen. Before this it landed there silently, identical to the user having
   * opened it themselves, and the only way to find out what had happened was
   * to guess that pressing "Test connection" would say.
   */
  it("returns to the connection screen carrying the reason", async () => {
    tokenRejected = true;
    render(<App />);
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => {
      ws.onopen?.();
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/rejected this access token/i);
    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument();
  });

  it("shows no such notice when the user opens the screen themselves", async () => {
    await mountConnected();
    fireEvent.click(screen.getByRole("button", { name: /connection settings/i }));
    await settle();

    expect(screen.getByLabelText(/access token/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
