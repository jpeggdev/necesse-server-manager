// Drives useDaemon's `busy` flag with a fake WebSocket carrying real
// `task`/`task-done` message shapes - the hook has no other test coverage,
// and `busy` (added in Task 11's fix round) is exactly the signal the UI
// relies on to block launching a second mod/server task while one streams.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDaemon } from "../src/useDaemon";

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
  };
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
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

function send(ws: FakeWebSocket, msg: unknown) {
  act(() => {
    ws.onmessage?.({ data: JSON.stringify(msg) });
  });
}

describe("useDaemon busy tracking", () => {
  it("is not busy before any task starts", async () => {
    const { result, unmount } = await openConnection();
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("becomes busy on a task message and clears on its task-done", async () => {
    const { result, ws, unmount } = await openConnection();

    send(ws, { type: "task", taskId: "t1", kind: "mod-install", line: "downloading..." });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "task-done", taskId: "t1", kind: "mod-install", ok: true }),
      });
      await Promise.resolve();
    });
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("stays busy while a second concurrent task is still running", async () => {
    const { result, ws, unmount } = await openConnection();

    send(ws, { type: "task", taskId: "t1", kind: "mod-install", line: "a" });
    send(ws, { type: "task", taskId: "t2", kind: "mod-update-all", line: "b" });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "task-done", taskId: "t1", kind: "mod-install", ok: true }),
      });
      await Promise.resolve();
    });
    expect(result.current.busy).toBe(true); // t2 has not finished yet

    await act(async () => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "task-done", taskId: "t2", kind: "mod-update-all", ok: true }),
      });
      await Promise.resolve();
    });
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("reports busy=false on a failed task-done too, not only on ok:true", async () => {
    const { result, ws, unmount } = await openConnection();

    send(ws, { type: "task", taskId: "t1", kind: "server-update", line: "a" });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "task-done", taskId: "t1", kind: "server-update", ok: false, error: "boom" }),
      });
      await Promise.resolve();
    });
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("clears busy on disconnect so a dropped task-done can't strand it forever", async () => {
    const { result, ws, unmount } = await openConnection();

    send(ws, { type: "task", taskId: "t1", kind: "mod-install", line: "a" });
    expect(result.current.busy).toBe(true);

    act(() => {
      ws.onclose?.();
    });
    expect(result.current.busy).toBe(false);
    unmount();
  });
});

// registerTask() exists specifically to close the window between "the
// task-launching HTTP response resolved with a taskId" and "the daemon's
// first websocket 'task' line for it arrives" - relying on the "task"
// message alone (the previous fix round) left `busy` false for that whole
// span, during which Start would incorrectly re-enable while steamcmd/the
// installer was already running.
describe("useDaemon registerTask - closes the HTTP-response-to-first-line gap", () => {
  it("is busy immediately once a task is registered, before any websocket message at all", async () => {
    const { result, unmount } = await openConnection();
    expect(result.current.busy).toBe(false);

    act(() => {
      result.current.registerTask("t1");
    });
    expect(result.current.busy).toBe(true);
    unmount();
  });

  it("stays busy across the registered-but-no-line-yet window, through to task-done", async () => {
    const { result, ws, unmount } = await openConnection();

    act(() => {
      result.current.registerTask("t1");
    });
    expect(result.current.busy).toBe(true); // registered; steamcmd hasn't logged anything yet

    // The first real console line eventually arrives - must be a no-op
    // (already tracked), not a second, separately-cleared entry.
    send(ws, { type: "task", taskId: "t1", kind: "server-update", line: "Updating app..." });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "task-done", taskId: "t1", kind: "server-update", ok: true }),
      });
      await Promise.resolve();
    });
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("leaves busy false when a task launch is never registered (the failed-call case)", async () => {
    const { result, unmount } = await openConnection();
    // Mirrors App's guardTask(): a rejected fn() never reaches the .then()
    // that calls registerTask, so nothing here should ever mark this busy.
    expect(result.current.busy).toBe(false);
    unmount();
  });

  it("ignores a task-done for a taskId it never registered, without throwing or clearing an unrelated task", async () => {
    const { result, ws, unmount } = await openConnection();

    act(() => {
      result.current.registerTask("t1");
    });
    expect(result.current.busy).toBe(true);

    expect(() => {
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({ type: "task-done", taskId: "unknown-id", kind: "mod-install", ok: true }),
        });
      });
    }).not.toThrow();
    expect(result.current.busy).toBe(true); // t1 is unaffected by the unrelated task-done

    await act(async () => {
      ws.onmessage?.({ data: JSON.stringify({ type: "task-done", taskId: "t1", kind: "mod-install", ok: true }) });
      await Promise.resolve();
    });
    expect(result.current.busy).toBe(false);
    unmount();
  });
});
