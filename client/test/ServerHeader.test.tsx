import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ServerHeader } from "../src/ServerHeader";
import type { StatusPayload } from "../src/types";

const stopped: StatusPayload = {
  state: "stopped", world: null, pid: null, startedAt: null,
  port: null, slots: null, gameVersion: null, lastError: null,
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
