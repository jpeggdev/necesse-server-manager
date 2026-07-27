// `busy` is the signal the UI relies on to block launching a second
// mod/server task - and, more importantly, to block Start while steamcmd is
// mid-rewrite of the install or mods folder. It is read straight off the
// daemon's status payload (`activeTasks`), never reconstructed here by
// correlating the HTTP response that accepts a task against the websocket
// that streams it: those are independent channels with no ordering guarantee,
// and every attempt to correlate them raced. These tests drive the hook with a
// fake WebSocket carrying real message shapes.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDaemon, WS_FAILURE_THRESHOLD } from "../src/useDaemon";

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
    // no-op: nothing under test sends anything to the daemon
  }
  close() {
    this.onclose?.();
  }
}

// What GET /api/status will answer with. Mutable so a test can move the
// daemon's authoritative state and then force a re-read, exactly as a
// reconnect or a task-done-driven refresh() does.
let activeTasks: string[] = [];

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
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/api/status")) return jsonResponse(statusPayload());
      if (url.includes("/api/worlds")) return jsonResponse({ worlds: [], lastWorld: null, candidate: null });
      if (url.endsWith("/api/mods")) return jsonResponse({ managed: [], untracked: [] });
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openConnection() {
  const { result, unmount } = renderHook(() => useDaemon());
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  await act(async () => {
    ws.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
  });
  return { result, ws, unmount };
}

/** The daemon's `status` broadcast, which it sends whenever activeTasks changes. */
function pushStatus(ws: FakeWebSocket, ids: string[]) {
  activeTasks = ids;
  act(() => {
    ws.onmessage?.({ data: JSON.stringify({ type: "status", status: statusPayload() }) });
  });
}

/** The daemon's `backlog`, sent to every socket the moment it connects. */
function pushBacklog(ws: FakeWebSocket, ids: string[]) {
  activeTasks = ids;
  act(() => {
    ws.onmessage?.({ data: JSON.stringify({ type: "backlog", lines: [], status: statusPayload() }) });
  });
}

/** Drops the socket and runs the hook's 2s auto-retry, returning the new socket. */
function dropAndReconnect(ws: FakeWebSocket): FakeWebSocket {
  vi.useFakeTimers();
  try {
    act(() => {
      ws.onclose?.();
      vi.advanceTimersByTime(2000);
    });
  } finally {
    vi.useRealTimers();
  }
  const next = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  expect(next).not.toBe(ws);
  return next;
}

async function pushTaskDone(ws: FakeWebSocket, taskId: string, ok = true) {
  await act(async () => {
    ws.onmessage?.({ data: JSON.stringify({ type: "task-done", taskId, kind: "mod-install", ok }) });
    await Promise.resolve();
  });
}

describe("useDaemon busy", () => {
  it("is false when the daemon reports no active tasks", async () => {
    const { result, unmount } = await openConnection();
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("is true while the daemon reports an active task, and false once it clears", async () => {
    const { result, ws, unmount } = await openConnection();

    pushStatus(ws, ["t1"]);
    expect(result.current.busy).toBe(true);

    pushStatus(ws, []);
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("is true from the initial backlog if a task was already running before this client connected", async () => {
    // A page opened mid-install must not offer Start. Nothing about the
    // websocket task stream would tell it - only the status payload does.
    const { result, ws, unmount } = await openConnection();
    pushBacklog(ws, ["t1"]);
    expect(result.current.busy).toBe(true);
    unmount();
  });

  it("stays busy while one of two overlapping tasks is still running", async () => {
    const { result, ws, unmount } = await openConnection();

    pushStatus(ws, ["t1", "t2"]);
    expect(result.current.busy).toBe(true);

    pushStatus(ws, ["t2"]); // t1 finished; t2 has not
    expect(result.current.busy).toBe(true);

    pushStatus(ws, []);
    expect(result.current.busy).toBe(false);
    unmount();
  });
});

// The failure mode that broke two prior attempts: a task that fails
// immediately, whose terminal websocket message can arrive before (or without)
// anything the client would have used to register it. Nothing the client
// receives in any order may leave `busy` stuck true, because a stuck `busy`
// disables Start, Update Server, Add Mod and Update All for the whole session.
describe("useDaemon busy - orderings that previously wedged it", () => {
  it("a task that fails immediately ends with busy false", async () => {
    const { result, ws, unmount } = await openConnection();

    // task-done arrives with the client never having seen the task start.
    await pushTaskDone(ws, "t1", false);
    expect(result.current.busy).toBe(false);

    // ...and the status broadcast that accompanies it confirms it.
    pushStatus(ws, []);
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("a task-done for an id this client never saw start cannot wedge busy", async () => {
    const { result, ws, unmount } = await openConnection();

    pushStatus(ws, ["t1"]);
    expect(result.current.busy).toBe(true);

    await pushTaskDone(ws, "some-unrelated-id");
    expect(result.current.busy).toBe(true); // t1 is still genuinely running

    pushStatus(ws, []);
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("task lines alone never make it busy - only the daemon's own report does", async () => {
    // A stray `task` line (a duplicate frame, a replayed buffer) is console
    // output, not evidence about what is in flight.
    const { result, ws, unmount } = await openConnection();
    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "task", taskId: "t1", kind: "mod-install", line: "downloading..." }),
      });
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.console.some((l) => l.line === "downloading...")).toBe(true);
    unmount();
  });
});

/*
 * A websocket that never opens leaves the app on "Connecting to the daemon..."
 * indefinitely - `connected` stays false, so App never renders the real UI, and
 * nothing sets `error` because refresh() only ever ran from onopen and onerror
 * was a no-op. The operator watches a spinner and learns nothing. Spec 9
 * requires an unreachable daemon to be distinguishable from a daemon that
 * answers but errors, and neither half was met here.
 */
describe("useDaemon websocket connection failures", () => {
  /** Awaits enough microtask ticks for the HTTP probe (fetch + json) to settle. */
  async function flush() {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  }

  /** One failed connection attempt: error, close, then the hook's 2s retry. */
  async function failConnection() {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    act(() => {
      ws.onerror?.();
      ws.onclose?.();
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
  }

  it("says the socket is blocked while HTTP still answers, rather than spinning forever", async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useDaemon());

      // Below the threshold this is indistinguishable from a daemon
      // mid-restart, and must not paint an error over a transient blip.
      for (let i = 0; i < WS_FAILURE_THRESHOLD - 1; i++) await failConnection();
      expect(result.current.error).toBeNull();

      await failConnection();

      expect(result.current.connected).toBe(false);
      expect(result.current.error).toBeTruthy();
      expect(result.current.error).toMatch(/HTTP/);
      expect(result.current.error).toMatch(/socket/i);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the daemon as unreachable, in fetch's own words, when HTTP fails too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useDaemon());
      for (let i = 0; i < WS_FAILURE_THRESHOLD; i++) await failConnection();

      expect(result.current.error).toMatch(/Could not reach the daemon/i);
      expect(result.current.error).toMatch(/Failed to fetch/);
      // The blocked-socket wording would be a lie here: nothing answered.
      expect(result.current.error).not.toMatch(/answers over HTTP/i);
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not raise a connection error for a socket that keeps opening and dropping", async () => {
    // A daemon being restarted drops the socket repeatedly, but each attempt
    // succeeds - that is a working setup, not a broken one, and the counter
    // resets on every open.
    const { result, ws, unmount } = await openConnection();

    let current = ws;
    for (let i = 0; i < WS_FAILURE_THRESHOLD + 1; i++) {
      current = dropAndReconnect(current);
      await act(async () => {
        current.onopen?.();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(result.current.connected).toBe(true);
    expect(result.current.error).toBeNull();
    unmount();
  });
});

describe("useDaemon reconnect", () => {
  it("re-syncs to a still-running task after a reconnect instead of clearing busy", async () => {
    const { result, ws, unmount } = await openConnection();

    pushStatus(ws, ["t1"]);
    expect(result.current.busy).toBe(true);

    // The daemon still has t1 in flight; the fresh backlog says so.
    const reconnected = dropAndReconnect(ws);
    expect(result.current.connected).toBe(false);
    pushBacklog(reconnected, ["t1"]);
    expect(result.current.busy).toBe(true);

    unmount();
  });

  it("re-syncs to idle after a reconnect if the task finished during the outage", async () => {
    // The old design cleared its bookkeeping on close and could never learn
    // otherwise; this one re-reads the truth either way.
    const { result, ws, unmount } = await openConnection();

    pushStatus(ws, ["t1"]);
    expect(result.current.busy).toBe(true);

    pushBacklog(dropAndReconnect(ws), []);
    expect(result.current.busy).toBe(false);

    unmount();
  });

  it("recovers busy from GET /api/status alone, with no websocket message at all", async () => {
    // refresh() runs on every reconnect's onopen; it must carry the same
    // truth as the backlog, so neither channel is a special case.
    const { result, unmount } = await openConnection();
    expect(result.current.busy).toBe(false);

    activeTasks = ["t1"];
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.busy).toBe(true);

    unmount();
  });
});
