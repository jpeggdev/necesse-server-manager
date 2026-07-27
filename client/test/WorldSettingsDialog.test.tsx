// The world settings form. Every control it renders is built from what the
// daemon reported for that field, so most of these tests work by handing it a
// response that deliberately does NOT match the real game - an enum option set
// with an invented member and a missing vanilla one - and checking the form
// followed the response rather than a copy of the schema kept here.
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorldSettingsDialog } from "../src/WorldSettingsDialog";
import type { WorldSettingField, WorldSettingsResponse, WorldSettingsWriteResponse } from "../src/types";

const ENTRY = "Tulsa/worldSettings.cfg";
const BACKUP = "C:/Necesse/saves/worlds/Tulsa.zip.2026-07-27T05-01-02-003Z.bak";

/**
 * Deliberately not the real option set: `BRUTAL` and `ADVENTURE` are missing
 * and `MADE_UP_BY_THE_DAEMON` does not exist in the game. A form that renders
 * exactly this is reading the response; a form that renders the game's real
 * five is reading a constant it should not have.
 */
const DIFFICULTY_OPTIONS = ["CASUAL", "CLASSIC", "MADE_UP_BY_THE_DAEMON"];

const FIELDS: WorldSettingField[] = [
  { key: "allowCheats", value: "false", type: "boolean", editable: true },
  { key: "difficulty", value: "CLASSIC", type: "enum", options: DIFFICULTY_OPTIONS, editable: true },
  { key: "dayTimeMod", value: "1.0", type: "float", min: 0.1, max: 10, editable: true },
  { key: "maxSettlersPerSettlement", value: "-1", type: "int", min: -1, max: 1000, editable: true },
  { key: "gameVersion", value: "1.2.0", type: "string", editable: false },
  { key: "rpgskillsWorldStackLevel", value: "1", type: null, editable: false },
];

function response(fields: WorldSettingField[] = FIELDS): WorldSettingsResponse {
  return { ok: true, world: "Tulsa", entry: ENTRY, fields };
}

function writeResponse(
  over: Partial<WorldSettingsWriteResponse> = {},
): WorldSettingsWriteResponse {
  return { ...response(), backup: BACKUP, changed: ["allowCheats"], ...over };
}

/**
 * Resolver for a save held open, so the in-flight state is observable. At
 * module scope because it is assigned inside one closure and read inside
 * another, which is also what keeps its declared type intact.
 */
let releaseSave: ((r: WorldSettingsWriteResponse) => void) | null = null;

/** Mounts the dialog behind a real trigger, so focus has somewhere to go back to. */
function Host(props: {
  load: (world: string) => Promise<WorldSettingsResponse>;
  save: (world: string, changes: Record<string, boolean | number | string>) => Promise<WorldSettingsWriteResponse>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open settings</button>
      {open && (
        <WorldSettingsDialog
          world="Tulsa"
          load={props.load}
          save={props.save}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

async function openDialog(over: Partial<Parameters<typeof Host>[0]> = {}) {
  const load = over.load ?? vi.fn(async () => response());
  const save = over.save ?? vi.fn(async () => writeResponse());
  render(<Host load={load} save={save} />);
  const trigger = screen.getByRole("button", { name: /open settings/i });
  await userEvent.click(trigger);
  await screen.findByLabelText("allowCheats");
  return { load, save, trigger };
}

describe("WorldSettingsDialog", () => {
  it("is a labelled modal dialog naming the world", async () => {
    await openDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog).toHaveAccessibleName(/world settings/i);
    expect(dialog).toHaveAccessibleName(/tulsa/i);
  });

  it("renders one labelled control per field, of the type the daemon reported", async () => {
    await openDialog();

    const bool = screen.getByLabelText("allowCheats");
    expect(bool).toHaveAttribute("type", "checkbox");
    expect(bool).not.toBeChecked();

    expect(screen.getByLabelText("difficulty").tagName).toBe("SELECT");

    const float = screen.getByLabelText("dayTimeMod");
    expect(float).toHaveAttribute("type", "number");
    expect(float).toHaveValue(1);

    const int = screen.getByLabelText("maxSettlersPerSettlement");
    expect(int).toHaveAttribute("type", "number");
    expect(int).toHaveValue(-1);
  });

  it("respects the reported bounds, and shows the float's documented max", async () => {
    await openDialog();
    const float = screen.getByLabelText("dayTimeMod");
    expect(float).toHaveAttribute("min", "0.1");
    expect(float).toHaveAttribute("max", "10");
    // The max of 10 is the one bound the file itself documents, so it has to be
    // on screen and not only enforced by the browser's validity check.
    expect(screen.getByText(/0\.1 to 10/)).toBeTruthy();

    const int = screen.getByLabelText("maxSettlersPerSettlement");
    expect(int).toHaveAttribute("min", "-1");
    expect(int).toHaveAttribute("max", "1000");
  });

  it("offers exactly the enum options the response carried, and no others", async () => {
    await openDialog();
    const select = screen.getByLabelText("difficulty");
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toEqual(DIFFICULTY_OPTIONS);
    // A real game value the response did not list must not appear: the daemon
    // read the option set out of Server.jar and it is the ground truth here.
    expect(screen.queryByRole("option", { name: "BRUTAL" })).toBeNull();
  });

  it("keeps a current enum value the reported options do not contain", async () => {
    // Otherwise the select would silently display (and then save) the first
    // option, turning merely opening the dialog into an edit.
    await openDialog({
      load: vi.fn(async () =>
        response(
          FIELDS.map((f) =>
            f.key === "difficulty" ? { ...f, value: "SOMETHING_ELSE" } : f,
          ),
        ),
      ),
    });
    expect(screen.getByLabelText("difficulty")).toHaveValue("SOMETHING_ELSE");
  });

  it("shows gameVersion read-only", async () => {
    await openDialog();
    const version = screen.getByLabelText("gameVersion");
    expect(version).toHaveValue("1.2.0");
    expect(version).toHaveAttribute("readonly");
  });

  it("shows a mod-written key read-only and says who wrote it, rather than hiding it", async () => {
    await openDialog();
    const modKey = screen.getByLabelText("rpgskillsWorldStackLevel");
    expect(modKey).toHaveValue("1");
    expect(modKey).toHaveAttribute("readonly");
    expect(screen.getByText(/written by a mod/i)).toBeTruthy();
    expect(screen.getByText(/preserved/i)).toBeTruthy();
  });

  it("says a timestamped backup is taken before anything is saved", async () => {
    await openDialog();
    expect(screen.getByText(/timestamped backup/i)).toBeTruthy();
    // ...and it says so before the save, not only after it.
    expect(screen.queryByText(/backup written to/i)).toBeNull();
  });

  it("sends only the fields that changed", async () => {
    const { save } = await openDialog();
    await userEvent.click(screen.getByLabelText("allowCheats"));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // Not difficulty, not dayTimeMod, and above all not gameVersion or the
    // mod's key: a save that transmitted them would rewrite lines nobody touched.
    expect(save).toHaveBeenCalledWith("Tulsa", { allowCheats: true });
  });

  it("sends each changed field as the JSON type its reported type calls for", async () => {
    const { save } = await openDialog();
    await userEvent.selectOptions(screen.getByLabelText("difficulty"), "CASUAL");
    // fireEvent, not typing: a number input passes through invalid intermediate
    // states ("2.") while a decimal is typed, which is a jsdom quirk rather
    // than anything this form does.
    fireEvent.change(screen.getByLabelText("dayTimeMod"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("maxSettlersPerSettlement"), { target: { value: "40" } });
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith("Tulsa", {
      difficulty: "CASUAL",
      dayTimeMod: 2.5,
      maxSettlersPerSettlement: 40,
    });
  });

  it("treats a numerically identical edit as no change at all", async () => {
    // The file says 1.0; typing 1 is the same value, and rewriting that line
    // would touch a field the user did not change.
    const { save } = await openDialog();
    fireEvent.change(screen.getByLabelText("dayTimeMod"), { target: { value: "1" } });
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });

  /*
   * An emptied number box is the one input state that can silently rewrite a
   * world. `Number("")` is 0, and 0 is inside the daemon's range for every
   * numeric field, so a form that treated an empty box as a value would turn
   * maxSettlersPerSettlement from -1 (no limit) into 0 (none at all) - a real
   * change to somebody's world, made through a gesture that looks like leaving
   * the field alone. The stored value below is negative precisely so that a
   * leaked 0 would be ACCEPTED by the daemon rather than bounced.
   */
  describe("a number box left empty", () => {
    async function clearTheInt() {
      const opened = await openDialog();
      fireEvent.change(screen.getByLabelText("maxSettlersPerSettlement"), { target: { value: "" } });
      return opened;
    }

    it("blocks the save and puts nothing in the payload", async () => {
      const { save } = await clearTheInt();
      const saveBtn = screen.getByRole("button", { name: /^save$/i });
      expect(saveBtn).toBeDisabled();
      fireEvent.click(saveBtn);
      expect(save).not.toHaveBeenCalled();
    });

    it("blocks the save even when another field has a real edit to make", async () => {
      // The dangerous shape: the user changes something legitimately, empties
      // another box, and saves. Nothing may go out for the empty one.
      const { save } = await clearTheInt();
      await userEvent.click(screen.getByLabelText("allowCheats"));
      const saveBtn = screen.getByRole("button", { name: /^save$/i });
      expect(saveBtn).toBeDisabled();
      fireEvent.click(saveBtn);
      expect(save).not.toHaveBeenCalled();
    });

    it("says which field is empty, on the field and on the button", async () => {
      await clearTheInt();
      expect(screen.getByLabelText("maxSettlersPerSettlement")).toHaveAttribute(
        "aria-invalid",
        "true",
      );
      // Names the stored value, so the way back is on screen.
      expect(screen.getByText(/left empty.*put back the stored -1/i)).toBeTruthy();
      expect(screen.getByRole("button", { name: /^save$/i }).getAttribute("title")).toMatch(
        /maxSettlersPerSettlement/,
      );
    });

    it("recovers the moment a number is typed back in", async () => {
      const { save } = await clearTheInt();
      fireEvent.change(screen.getByLabelText("maxSettlersPerSettlement"), { target: { value: "5" } });
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
      await waitFor(() => expect(save).toHaveBeenCalledWith("Tulsa", { maxSettlersPerSettlement: 5 }));
    });

    it("is not confused with a field genuinely set to zero", async () => {
      const { save } = await openDialog();
      fireEvent.change(screen.getByLabelText("maxSettlersPerSettlement"), { target: { value: "0" } });
      await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
      await waitFor(() => expect(save).toHaveBeenCalledWith("Tulsa", { maxSettlersPerSettlement: 0 }));
    });
  });

  it("cannot be saved before anything is changed", async () => {
    await openDialog();
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    expect(saveBtn).toBeDisabled();
    expect(saveBtn.getAttribute("title")).toMatch(/nothing/i);
  });

  it("reports where the backup went after a successful save", async () => {
    await openDialog();
    await userEvent.click(screen.getByLabelText("allowCheats"));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(new RegExp(`Backup written to ${BACKUP}`))).toBeTruthy();
  });

  it("says plainly when a save wrote nothing because the values already matched", async () => {
    await openDialog({ save: vi.fn(async () => writeResponse({ backup: null, changed: [] })) });
    await userEvent.click(screen.getByLabelText("allowCheats"));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/nothing was written/i)).toBeTruthy();
  });

  it("shows the daemon's own refusal verbatim", async () => {
    const message =
      'Cannot change world settings while the server is running. A world zip is the only copy ' +
      'of that save, so this needs the server confirmed stopped - not stopping, not crashed, ' +
      'not running outside this daemon. Stop it and try again.';
    await openDialog({ save: vi.fn(async () => Promise.reject(new Error(message))) });
    await userEvent.click(screen.getByLabelText("allowCheats"));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(message)).toBeTruthy();
    // The dialog stays open on failure: the form still holds the edit.
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows the daemon's own text when the settings cannot even be read", async () => {
    const message = 'No world named "Tulsa".';
    render(
      <Host
        load={vi.fn(async () => Promise.reject(new Error(message)))}
        save={vi.fn(async () => writeResponse())}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /open settings/i }));
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it("freezes every control while a save is in flight", async () => {
    releaseSave = null;
    await openDialog({
      save: vi.fn(
        () =>
          new Promise<WorldSettingsWriteResponse>((resolve) => {
            releaseSave = resolve;
          }),
      ),
    });
    await userEvent.click(screen.getByLabelText("allowCheats"));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(screen.getByLabelText("allowCheats")).toBeDisabled();
    expect(screen.getByLabelText("difficulty")).toBeDisabled();
    expect(screen.getByLabelText("dayTimeMod")).toBeDisabled();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();

    // Escape must not walk away from a write already in flight either.
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();

    await waitFor(() => expect(releaseSave).not.toBeNull());
    releaseSave!(writeResponse());
    await screen.findByText(new RegExp(`Backup written to ${BACKUP}`));
  });

  it("closes on Escape without saving", async () => {
    const { save } = await openDialog();
    await userEvent.click(screen.getByLabelText("allowCheats"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).not.toHaveBeenCalled();
  });

  it("closes on Cancel without saving", async () => {
    const { save } = await openDialog();
    await userEvent.click(screen.getByLabelText("allowCheats"));
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(save).not.toHaveBeenCalled();
  });

  it("takes focus on open and gives it back to the trigger on close", async () => {
    const { trigger } = await openDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  /*
   * `aria-modal="true"` is a promise to a screen reader that nothing outside
   * this dialog is reachable. Focus opens on a control that is neither the
   * first nor the last of anything, so the interesting direction is Shift+Tab
   * from the state the dialog actually opens in - and once focus is out, a
   * handler bound to the dialog is no longer in the event path and can never
   * pull it back, so the escape is permanent rather than a one-key detour.
   */
  describe("focus containment", () => {
    it("keeps Shift+Tab inside, from the very state it opens in", async () => {
      const { trigger } = await openDialog();
      const dialog = screen.getByRole("dialog");
      await userEvent.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(trigger);
      expect(document.activeElement).not.toBe(document.body);
    });

    it("keeps Tab inside for a full cycle in both directions", async () => {
      await openDialog();
      const dialog = screen.getByRole("dialog");
      // More presses than there are controls, so the wrap at each end is
      // crossed rather than just approached.
      for (let i = 0; i < 14; i++) {
        await userEvent.tab();
        expect(dialog.contains(document.activeElement)).toBe(true);
      }
      for (let i = 0; i < 14; i++) {
        await userEvent.tab({ shift: true });
        expect(dialog.contains(document.activeElement)).toBe(true);
      }
    });

    it("pulls focus back when something outside takes it", async () => {
      // Tab is not the only way out: a click, or script, can move focus too.
      const { trigger } = await openDialog();
      trigger.focus();
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    });

    it("makes the rest of the page inert while it is open, and lets it go on close", async () => {
      const { trigger } = await openDialog();
      expect(trigger).toHaveAttribute("inert");
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(trigger).not.toHaveAttribute("inert");
    });
  });
});
