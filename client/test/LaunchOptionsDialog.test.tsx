import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LaunchOptionsDialog } from "../src/LaunchOptionsDialog";

const FIELDS = [
  { name: "owner", type: "string", group: "identity", label: "Owner", help: "One owner." },
  { name: "slots", type: "int", group: "capacity", label: "Player slots", help: "How many.", min: 1, max: 250 },
  { name: "pausewhenempty", type: "boolean", group: "behaviour", label: "Pause when empty", help: "Stops ticking." },
];

const makeApi = (over: Partial<Record<string, unknown>> = {}) => ({
  launchOptions: vi.fn().mockResolvedValue({
    ok: true,
    world: "Tulsa",
    defaults: { owner: "Jeff", slots: 5 },
    overrides: {},
    effective: { owner: "Jeff", slots: 5 },
    fields: FIELDS,
  }),
  saveLaunchOptions: vi.fn().mockResolvedValue({
    ok: true,
    world: "Tulsa",
    defaults: { owner: "Jeff", slots: 5 },
    overrides: { slots: 20 },
    effective: { owner: "Jeff", slots: 20 },
    fields: FIELDS,
  }),
  ...over,
});

describe("LaunchOptionsDialog", () => {
  it("shows each field with its effective value", async () => {
    render(<LaunchOptionsDialog world="Tulsa" api={makeApi() as never} serverRunningThisWorld={false} onClose={() => {}} />);
    expect(await screen.findByLabelText(/owner/i)).toHaveValue("Jeff");
    expect(screen.getByLabelText(/player slots/i)).toHaveValue(5);
  });

  it("marks a value that comes from the defaults as inherited", async () => {
    render(<LaunchOptionsDialog world="Tulsa" api={makeApi() as never} serverRunningThisWorld={false} onClose={() => {}} />);
    await screen.findByLabelText(/owner/i);
    expect(screen.getAllByText(/inherited/i).length).toBeGreaterThan(0);
  });

  it("saves only what changed", async () => {
    const api = makeApi();
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    const slots = await screen.findByLabelText(/player slots/i);
    await userEvent.clear(slots);
    await userEvent.type(slots, "20");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(api.saveLaunchOptions).toHaveBeenCalledWith("Tulsa", { slots: 20 }));
  });

  it("clears an override with revert, sending null", async () => {
    const api = makeApi({
      launchOptions: vi.fn().mockResolvedValue({
        ok: true,
        world: "Tulsa",
        defaults: { slots: 5 },
        overrides: { slots: 20 },
        effective: { slots: 20 },
        fields: FIELDS,
      }),
    });
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    await screen.findByLabelText(/player slots/i);
    await userEvent.click(screen.getByRole("button", { name: /revert.*player slots/i }));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(api.saveLaunchOptions).toHaveBeenCalledWith("Tulsa", { slots: null }));
  });

  it("shows the daemon's refusal without rewording it", async () => {
    const api = makeApi({
      saveLaunchOptions: vi.fn().mockRejectedValue(new Error('"slots" must be between 1 and 250')),
    });
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    const slots = await screen.findByLabelText(/player slots/i);
    await userEvent.clear(slots);
    await userEvent.type(slots, "999");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/between 1 and 250/);
  });

  it("says changes apply at the next start when the server is running this world", async () => {
    render(<LaunchOptionsDialog world="Tulsa" api={makeApi() as never} serverRunningThisWorld onClose={() => {}} />);
    expect(await screen.findByRole("status")).toHaveTextContent(/next start/i);
  });

  it("warns that the game port needs its own firewall rule", async () => {
    render(<LaunchOptionsDialog world="Tulsa" api={makeApi() as never} serverRunningThisWorld={false} onClose={() => {}} />);
    await screen.findByLabelText(/owner/i);
    expect(screen.getByText(/firewall/i)).toBeInTheDocument();
  });
});
