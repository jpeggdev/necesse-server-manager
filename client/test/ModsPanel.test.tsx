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
  it("lists managed mods with id and jar", () => {
    setup();
    expect(screen.getByText("Safe Haven QOL")).toBeTruthy();
    expect(screen.getByText("3731244177")).toBeTruthy();
    expect(screen.getByText("SafeHavenQOL-1.2.0-2.6.jar")).toBeTruthy();
  });

  it("shows untracked jars labelled as not updatable", () => {
    setup();
    expect(screen.getByText("MysteryMod.jar")).toBeTruthy();
    expect(screen.getByText(/untracked/i)).toBeTruthy();
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
