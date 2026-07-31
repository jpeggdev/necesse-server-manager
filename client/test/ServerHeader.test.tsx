import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerHeader } from "../src/ServerHeader";
import type { StatusPayload } from "../src/types";

const stopped: StatusPayload = {
  state: "stopped", world: null, pid: null, startedAt: null,
  port: null, slots: null, gameVersion: null, lastError: null, activeTasks: [],
  configWarnings: [],
};
const running: StatusPayload = { ...stopped, state: "running", world: "Tulsa", pid: 42, port: 14159 };

const worlds = {
  worlds: [
    { name: "Tulsa", modifiedAt: "2026-07-25T18:40:00.000Z", sizeBytes: 1 },
    { name: "Infected Toenail", modifiedAt: "2026-07-26T04:40:00.000Z", sizeBytes: 2 },
  ],
  lastWorld: "Infected Toenail",
  candidate: null,
};

function setup(overrides: Partial<Parameters<typeof ServerHeader>[0]> = {}) {
  const props = {
    status: stopped,
    worlds,
    candidate: null,
    onStart: vi.fn(),
    onStop: vi.fn(),
    onKill: vi.fn(),
    onUpdateServer: vi.fn(),
    onCandidateChange: vi.fn(),
    onEditConnection: vi.fn(),
    ...overrides,
  };
  const { rerender } = render(<ServerHeader {...props} />);
  return { ...props, rerender };
}

describe("ServerHeader", () => {
  it("prefills the world field with lastWorld", () => {
    setup();
    expect(screen.getByLabelText(/world/i)).toHaveValue("Infected Toenail");
  });

  it("lets the user type a world name that is not in the list, once the candidate resolves for it", async () => {
    const { rerender, ...headerProps } = setup();
    const input = screen.getByLabelText(/world/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Brand New World");
    expect(input).toHaveValue("Brand New World");
    // Before the (debounced, async) candidate lookup resolves for this exact
    // text, Start must stay disabled - clicking it here must be a no-op.
    expect(screen.getByRole("button", { name: /^start$/i })).toBeDisabled();
    rerender(
      <ServerHeader
        {...headerProps}
        candidate={{ name: "Brand New World", valid: true, exists: false }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^start$/i }));
    expect(headerProps.onStart).toHaveBeenCalledWith("Brand New World");
  });

  it("warns that an unknown name will create a world", () => {
    setup({
      worlds: { ...worlds, lastWorld: "Brand New" },
      candidate: { name: "Brand New", valid: true, exists: false },
    });
    expect(screen.getByText(/will create a new world/i)).toBeTruthy();
  });

  it("says an existing name will be loaded", () => {
    setup({
      worlds: { ...worlds, lastWorld: "Tulsa" },
      candidate: { name: "Tulsa", valid: true, exists: true },
    });
    expect(screen.getByText(/will load existing world/i)).toBeTruthy();
  });

  it("blocks Start on an invalid name", () => {
    setup({
      worlds: { ...worlds, lastWorld: "bad:name" },
      candidate: { name: "bad:name", valid: false, exists: false },
    });
    expect(screen.getByRole("button", { name: /^start$/i })).toBeDisabled();
  });

  it("shows Stop instead of Start while running", () => {
    setup({ status: running });
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^start$/i })).toBeNull();
  });

  it("shows Stop, disabled, instead of Start while stopping", () => {
    setup({ status: { ...running, state: "stopping" } });
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^start$/i })).toBeNull();
  });

  it("disables Update Server while running and explains why", () => {
    setup({ status: running });
    const btn = screen.getByRole("button", { name: /update server/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/stop/i);
  });

  it("offers kill only when unmanaged", () => {
    setup({ status: running });
    expect(screen.queryByRole("button", { name: /force kill/i })).toBeNull();
    setup({ status: { ...stopped, state: "unmanaged", pid: 999 } });
    expect(screen.getByRole("button", { name: /force kill/i })).toBeTruthy();
  });

  /*
   * After a stop times out the daemon deliberately leaves the process running
   * and answers 504. State stays `stopping`, so pre-fix the header rendered a
   * disabled Stop, no Start, and no kill: the operator was told "the process
   * was left running" and then given nothing to act with, short of curl.
   * Spec 4 requires the timeout to "offer a kill as an explicit, separately
   * confirmed action". The trigger is the timeout having actually happened -
   * NOT `stopping` itself, which is the healthy common case.
   */
  describe("after a stop timeout", () => {
    const stopping: StatusPayload = { ...running, state: "stopping" };

    it("offers Force kill, visually dangerous and stating the world-loss risk", () => {
      setup({ status: stopping, stopTimedOut: true });
      const btn = screen.getByRole("button", { name: /force kill/i });
      expect(btn).toBeEnabled();
      expect(btn.className).toMatch(/danger/);
      expect(btn.getAttribute("title")).toMatch(/world/i);
      // ...and it is not mistakable for the ordinary Stop, which stays put and disabled.
      expect(screen.getByRole("button", { name: /^stop$/i })).toBeDisabled();
      expect(screen.getByText(/timed out/i)).toBeTruthy();
    });

    it("fires onKill when clicked", async () => {
      const props = setup({ status: stopping, stopTimedOut: true });
      await userEvent.click(screen.getByRole("button", { name: /force kill/i }));
      expect(props.onKill).toHaveBeenCalledTimes(1);
    });

    it("stays hidden during an ordinary healthy shutdown", () => {
      setup({ status: stopping });
      expect(screen.queryByRole("button", { name: /force kill/i })).toBeNull();
      expect(screen.queryByText(/timed out/i)).toBeNull();
    });

    it("stays hidden while the server is running, even if a previous stop timed out", () => {
      setup({ status: running, stopTimedOut: true });
      expect(screen.queryByRole("button", { name: /force kill/i })).toBeNull();
    });
  });

  /*
   * The world settings editor rewrites the zip that IS somebody's save, and
   * the daemon will only do it with the server verifiably stopped and nothing
   * else in flight. Finding that out from a 409 after filling in a form is not
   * good enough, so the trigger is disabled up front - and never silently:
   * every blocked case has to say which one it is.
   */
  describe("world settings trigger", () => {
    const existing = { name: "Tulsa", valid: true, exists: true };
    const openable = {
      worlds: { ...worlds, lastWorld: "Tulsa" },
      candidate: existing,
      onEditWorldSettings: vi.fn(),
    };

    it("opens the editor for the world in the field", async () => {
      const onEditWorldSettings = vi.fn();
      setup({ ...openable, onEditWorldSettings });
      const btn = screen.getByRole("button", { name: /world settings/i });
      expect(btn).toBeEnabled();
      await userEvent.click(btn);
      expect(onEditWorldSettings).toHaveBeenCalledWith("Tulsa");
    });

    it("is not offered at all when no handler is supplied", () => {
      setup({ worlds: { ...worlds, lastWorld: "Tulsa" }, candidate: existing });
      expect(screen.queryByRole("button", { name: /world settings/i })).toBeNull();
    });

    it("is disabled, saying so, while the server is running", () => {
      setup({ ...openable, status: running });
      const btn = screen.getByRole("button", { name: /world settings/i });
      expect(btn).toBeDisabled();
      expect(btn.getAttribute("title")).toMatch(/stopped/i);
      expect(btn.getAttribute("title")).toMatch(/running/i);
    });

    it("is disabled, saying so, for every state that is not a clean stop", () => {
      // The daemon refuses `crashed` and `unmanaged` too: a crash is exactly
      // the case where nobody can say what the server was doing to the zip.
      for (const state of ["starting", "stopping", "crashed", "unmanaged"] as const) {
        setup({ ...openable, status: { ...stopped, state } });
        const btn = screen.getAllByRole("button", { name: /world settings/i }).pop()!;
        expect(btn).toBeDisabled();
        expect(btn.getAttribute("title")).toMatch(/stopped/i);
      }
    });

    it("is disabled, saying so, while a task is in flight", () => {
      setup({ ...openable, busy: true });
      const btn = screen.getByRole("button", { name: /world settings/i });
      expect(btn).toBeDisabled();
      expect(btn.getAttribute("title")).toMatch(/task is already running/i);
    });

    it("is disabled, saying so, when the named world does not exist", () => {
      setup({
        ...openable,
        worlds: { ...worlds, lastWorld: "Brand New" },
        candidate: { name: "Brand New", valid: true, exists: false },
      });
      const btn = screen.getByRole("button", { name: /world settings/i });
      expect(btn).toBeDisabled();
      expect(btn.getAttribute("title")).toMatch(/no world named/i);
    });

    it("is disabled while the candidate for the typed name is still unresolved", async () => {
      // Same staleness rule Start obeys: the verdict in hand may describe a
      // name the user has already edited away from.
      const onEditWorldSettings = vi.fn();
      setup({ ...openable, onEditWorldSettings });
      await userEvent.type(screen.getByLabelText(/world/i), "x");
      const btn = screen.getByRole("button", { name: /world settings/i });
      expect(btn).toBeDisabled();
      expect(btn.getAttribute("title")).toMatch(/confirm/i);
      fireEvent.click(btn);
      expect(onEditWorldSettings).not.toHaveBeenCalled();
    });

    it("is disabled, saying so, on a name the daemon calls invalid", () => {
      setup({
        ...openable,
        worlds: { ...worlds, lastWorld: "bad:name" },
        candidate: { name: "bad:name", valid: false, exists: false },
      });
      const btn = screen.getByRole("button", { name: /world settings/i });
      expect(btn).toBeDisabled();
      expect(btn.getAttribute("title")).toMatch(/not a valid world name/i);
    });
  });

  it("does not fire onCandidateChange on every keystroke (debounced)", () => {
    vi.useFakeTimers();
    try {
      const onCandidateChange = vi.fn();
      setup({ onCandidateChange });
      onCandidateChange.mockClear(); // drop the initial-mount call
      const input = screen.getByLabelText(/world/i);
      fireEvent.change(input, { target: { value: "X" } });
      fireEvent.change(input, { target: { value: "Xy" } });
      fireEvent.change(input, { target: { value: "Xyz" } });
      expect(onCandidateChange).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(onCandidateChange).toHaveBeenCalledTimes(1);
      expect(onCandidateChange).toHaveBeenCalledWith("Xyz");
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables Update Server (with reason) while a task is busy, even if not running", () => {
    setup({ status: stopped, busy: true });
    const btn = screen.getByRole("button", { name: /update server/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/running|progress/i);
  });

  it("disables Start while a task is busy, with a perceivable reason", () => {
    setup({
      status: stopped,
      busy: true,
      worlds: { ...worlds, lastWorld: "Infected Toenail" },
      candidate: { name: "Infected Toenail", valid: true, exists: true },
    });
    const btn = screen.getByRole("button", { name: /^start$/i });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/running|progress/i);
  });

  it("prefers the actually-running world over lastWorld on initial render", () => {
    setup({ status: running, worlds: { ...worlds, lastWorld: "Infected Toenail" } });
    expect(screen.getByLabelText(/world/i)).toHaveValue("Tulsa");
  });

  it("does not clobber what the user typed when a websocket status push re-renders it", async () => {
    const onStart = vi.fn();
    const { rerender } = render(
      <ServerHeader
        status={stopped}
        worlds={worlds}
        candidate={null}
        onStart={onStart}
        onStop={vi.fn()}
        onKill={vi.fn()}
        onUpdateServer={vi.fn()}
        onCandidateChange={vi.fn()}
        onEditConnection={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(/world/i);
    await userEvent.clear(input);
    await userEvent.type(input, "Brand New World");

    // Simulate a WS-driven status push causing App to re-render this
    // component with fresh (but otherwise unrelated) props.
    rerender(
      <ServerHeader
        status={{ ...stopped, lastError: "previous run crashed" }}
        worlds={worlds}
        candidate={null}
        onStart={onStart}
        onStop={vi.fn()}
        onKill={vi.fn()}
        onUpdateServer={vi.fn()}
        onCandidateChange={vi.fn()}
        onEditConnection={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/world/i)).toHaveValue("Brand New World");
  });

  it("shows a checking state and disables Start once the typed text no longer matches the resolved candidate", async () => {
    const props = setup({
      worlds: { ...worlds, lastWorld: "Infected Toenail" },
      candidate: { name: "Infected Toenail", valid: true, exists: true },
    });
    // Matches at mount: the real verdict shows.
    expect(screen.getByText(/will load existing world/i)).toBeTruthy();

    const input = screen.getByLabelText(/world/i);
    await userEvent.type(input, "x"); // now "Infected Toenailx" - candidate is stale

    expect(screen.queryByText(/will load existing world/i)).toBeNull();
    expect(screen.queryByText(/will create a new world/i)).toBeNull();
    expect(screen.getByText(/checking/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^start$/i })).toBeDisabled();
    expect(props.onStart).not.toHaveBeenCalled();
  });

  it("never invokes onStart with a name the candidate has not validated, even if clicked", async () => {
    const props = setup({
      worlds: { ...worlds, lastWorld: "Infected Toenail" },
      candidate: { name: "Infected Toenail", valid: true, exists: true },
    });
    const input = screen.getByLabelText(/world/i);
    await userEvent.type(input, "typo"); // "Infected Toenailtypo" - unvalidated
    const btn = screen.getByRole("button", { name: /^start$/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn); // disabled buttons swallow the click; assert it truly does
    expect(props.onStart).not.toHaveBeenCalled();
  });
});
