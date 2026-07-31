import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LaunchOptionsDialog, parseIntBoxValue } from "../src/LaunchOptionsDialog";

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

  it("marks only the fields without an override as inherited", async () => {
    // Mixed fixture on purpose: owner and pausewhenempty have no override,
    // slots does. A hard-coded `inherited={true}` would report 3 inherited
    // fields and would also render slots' Revert button (only "inherited"
    // fields ever showed it), so this fails either way if the flag is wired
    // wrong - unlike a fixture where every field is inherited, which a
    // hard-coded `true` satisfies by accident.
    const api = makeApi({
      launchOptions: vi.fn().mockResolvedValue({
        ok: true,
        world: "Tulsa",
        defaults: { owner: "Jeff", slots: 5, pausewhenempty: false },
        overrides: { slots: 20 },
        effective: { owner: "Jeff", slots: 20, pausewhenempty: false },
        fields: FIELDS,
      }),
    });
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    await screen.findByLabelText(/owner/i);
    expect(screen.getAllByText(/inherited/i)).toHaveLength(2);
    expect(screen.getByRole("button", { name: /revert.*player slots/i })).toBeInTheDocument();
  });

  it("shows a number field nobody has set as unset, not as 0", async () => {
    // 0 is below `slots`' own declared minimum of 1 and nobody chose it, so
    // rendering it read as a real setting: "Player slots: 0, inherited from
    // defaults". A field with no override and no default has no value to show.
    const api = makeApi({
      launchOptions: vi.fn().mockResolvedValue({
        ok: true,
        world: "Tulsa",
        defaults: { owner: "Jeff" },
        overrides: {},
        effective: { owner: "Jeff" },
        fields: FIELDS,
      }),
    });
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    const slots = await screen.findByLabelText(/player slots/i);
    expect(slots).toHaveValue(null);
    expect(slots).toHaveAttribute("placeholder", "Not set");

    // And the invented value must not be saveable either: with nothing typed
    // there is nothing to write, so Save stays disabled.
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("sends only the edited field, not the whole form", async () => {
    // Corrected claim: this is NOT a second check on the unset-vs-0 rendering
    // above. Both the rendered value and the comparison baseline come from
    // `initialValue`, so they agree whichever value that function returns and
    // this test passes either way - it cannot see finding 6 at all.
    //
    // The failure mode it DOES name is the one the dialog's own doc warns
    // about: `changes` sending every field instead of the diff. That would
    // write an override for `slots` and `pausewhenempty` that the user never
    // touched, permanently detaching them from the daemon-wide defaults so a
    // later change to a default silently stopped reaching this world.
    const api = makeApi({
      launchOptions: vi.fn().mockResolvedValue({
        ok: true,
        world: "Tulsa",
        defaults: {},
        overrides: {},
        effective: {},
        fields: FIELDS,
      }),
    });
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    const owner = await screen.findByLabelText(/owner/i);
    await userEvent.type(owner, "Eli");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(api.saveLaunchOptions).toHaveBeenCalledWith("Tulsa", { owner: "Eli" }));
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

  it("names what it actually wrote in the post-save confirmation", async () => {
    // `adopt(r)` rebases the form onto the response before this renders, so
    // computing the message from the live `changes` diff (which is `{}` by
    // then) would always say nothing was written, even on a real success.
    const api = makeApi();
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    const slots = await screen.findByLabelText(/player slots/i);
    await userEvent.clear(slots);
    await userEvent.type(slots, "20");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByText(/saved slots/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing had changed/i)).toBeNull();
  });

  it("sends an empty string, not null, when a text field is cleared", async () => {
    const api = makeApi();
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    const owner = await screen.findByLabelText(/owner/i);
    await userEvent.clear(owner);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(api.saveLaunchOptions).toHaveBeenCalledWith("Tulsa", { owner: "" }));
  });

  it("disables save again once an edited field is edited back to its loaded value", async () => {
    const api = makeApi();
    render(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />);
    const owner = await screen.findByLabelText(/owner/i);
    await userEvent.type(owner, "X");
    expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
    await userEvent.type(owner, "{backspace}");
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
    expect(api.saveLaunchOptions).not.toHaveBeenCalled();
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

  it("sends null, not 0, when an overridden number box is simply emptied", async () => {
    // 0 is a LEGAL value for several int fields (itemslife, worldborder,
    // maxsettlements, maxsettlers), so coercing a blank box to 0 would write
    // a real, permanent override rather than clearing one - the same
    // null-vs-empty confusion requirement (B) exists to prevent, reached from
    // the empty-input side instead of the empty-string side.
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
    const slots = await screen.findByLabelText(/player slots/i);
    await userEvent.clear(slots);
    expect(slots).toHaveValue(null);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(api.saveLaunchOptions).toHaveBeenCalledWith("Tulsa", { slots: null }));
  });

  // Drives the handler directly with a non-finite value rather than trying
  // to simulate the keystroke sequence: jsdom's <input type="number"> may
  // sanitize an in-progress "-" before onChange ever sees it, but a real
  // browser is not guaranteed to, and it is the handler's own reaction to
  // that value - not whether jsdom can be made to produce it - that matters.
  it("does not stage a non-finite number as a value or a clear", () => {
    expect(parseIntBoxValue("-")).toBeUndefined();
    expect(parseIntBoxValue("NaN")).toBeUndefined();
    // The two values this function DOES commit to, so the guard above is
    // shown to be an addition rather than a stand-in that swallows everything.
    expect(parseIntBoxValue("")).toBe("");
    expect(parseIntBoxValue("-1")).toBe(-1);
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

  it("shows the next-start notice only while serverRunningThisWorld is true", async () => {
    // Pins the TRIGGER, not just the message: a hard-coded `{true && (...)}`
    // in place of the `serverRunningThisWorld` gate would still pass a test
    // that only ever rendered with the prop true.
    const api = makeApi();
    const { rerender } = render(
      <LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld={false} onClose={() => {}} />,
    );
    await screen.findByLabelText(/owner/i);
    expect(screen.queryByRole("status")).toBeNull();

    rerender(<LaunchOptionsDialog world="Tulsa" api={api as never} serverRunningThisWorld onClose={() => {}} />);
    expect(await screen.findByRole("status")).toHaveTextContent(/next start/i);
  });

  it("warns that the game port needs its own firewall rule", async () => {
    render(<LaunchOptionsDialog world="Tulsa" api={makeApi() as never} serverRunningThisWorld={false} onClose={() => {}} />);
    await screen.findByLabelText(/owner/i);
    expect(screen.getByText(/firewall/i)).toBeInTheDocument();
  });
});
