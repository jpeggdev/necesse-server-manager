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
/** Holds POST /api/server/update open so the click-to-response span is observable. */
let releaseUpdate: (() => void) | null = null;

function statusPayload() {
  return {
    state: "stopped",
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
  releaseUpdate = null;
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
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
