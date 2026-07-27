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
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
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
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  activeTasks = [];
  serverState = "stopped";
  releaseUpdate = null;
  stopResponse = null;
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/server/stop") && stopResponse) {
        return { ok: stopResponse.ok, status: stopResponse.status, json: async () => stopResponse!.body };
      }
      if (url.endsWith("/api/server/update")) {
        return new Promise((resolve) => {
          releaseUpdate = () => resolve(jsonResponse({ ok: true, taskId: "t1" }));
        });
      }
      if (url.endsWith("/api/status")) return jsonResponse(statusPayload());
      if (url.includes("/api/worlds")) {
        return jsonResponse({ worlds: [], lastWorld: "Tulsa", candidate: null });
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
