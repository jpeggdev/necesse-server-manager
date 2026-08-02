import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandDialog } from "../src/CommandDialog";
import type { Api } from "../src/api";
import type { CommandDef, PlayerEntry } from "../src/types";

const COMMANDS: CommandDef[] = [
  {
    name: "say",
    description: "Talks in the chat as Server",
    permission: "MODERATOR",
    isCheat: false,
    params: [{ name: "message", type: "text", optional: false }],
  },
  {
    name: "kick",
    description: "Kicks player from the server",
    permission: "MODERATOR",
    isCheat: false,
    params: [
      { name: "player", type: "player", optional: false },
      { name: "message/reason", type: "text", optional: true },
    ],
  },
  {
    name: "give",
    description: "Gives item to player",
    permission: "ADMIN",
    isCheat: true,
    params: [
      { name: "player", type: "player", optional: true },
      { name: "item", type: "text", optional: false },
      { name: "amount", type: "int", optional: true },
    ],
  },
  {
    name: "allowcheats",
    description: "Enables cheats on the world",
    permission: "OWNER",
    isCheat: true,
    destructive: true,
    params: [],
  },
  { name: "die", description: "Kills yourself", permission: "USER", isCheat: false, playerOnly: true, params: [] },
];

const PLAYERS: PlayerEntry[] = [
  { auth: "1", name: "Jeff", slot: 1, latency: 4, level: "surface", joinedAt: null },
  { auth: "2", name: "eli", slot: 2, latency: 9, level: "cave", joinedAt: null },
];

let runCommand: ReturnType<typeof vi.fn>;
function makeApi(gameVersion = "1.3.1", schemaGameVersion = "1.3.1"): Api {
  runCommand = vi.fn(async (name: string, args: Record<string, string>) => ({
    ok: true as const,
    sent: [name, ...Object.values(args)].join(" "),
  }));
  return {
    commands: vi.fn(async () => ({
      ok: true as const,
      commands: COMMANDS,
      schemaGameVersion,
      gameVersion,
    })),
    runCommand,
  } as unknown as Api;
}

function open(api: Api = makeApi(), players: PlayerEntry[] = PLAYERS) {
  return render(<CommandDialog api={api} players={players} onClose={vi.fn()} />);
}

async function choose(name: string) {
  await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Command" }), name);
}

beforeEach(() => {
  runCommand = vi.fn();
});

describe("CommandDialog", () => {
  it("lists the commands the daemon offers", async () => {
    open();
    const picker = await screen.findByRole("combobox", { name: "Command" });
    expect(picker).toHaveTextContent("say");
    expect(picker).toHaveTextContent("give");
  });

  // The console is not a player, so these act on nobody.
  it("does not offer commands that act on the caller", async () => {
    open();
    const picker = await screen.findByRole("combobox", { name: "Command" });
    expect(picker).not.toHaveTextContent("die");
  });

  it("renders a field per parameter of the chosen command", async () => {
    open();
    await choose("give");
    expect(screen.getByLabelText(/item/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/amount/i)).toBeInTheDocument();
  });

  it("offers the live roster for a player parameter", async () => {
    open();
    await choose("kick");
    const player = screen.getByRole("combobox", { name: "player" });
    expect(player).toHaveTextContent("Jeff");
    expect(player).toHaveTextContent("eli");
  });

  it("sends the command with the values entered", async () => {
    open();
    await choose("say");
    await userEvent.type(screen.getByLabelText(/message/i), "back in five");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith("say", { message: "back in five" }));
  });

  it("omits an optional the operator left blank", async () => {
    open();
    await choose("give");
    await userEvent.type(screen.getByLabelText(/item/i), "iron_bar");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(runCommand).toHaveBeenCalledWith("give", { item: "iron_bar" }));
  });

  it("will not send while a required field is empty", async () => {
    open();
    await choose("say");
    expect(screen.getByRole("button", { name: /^send$/i })).toBeDisabled();
  });

  it("marks a cheat command, because it needs cheats enabled on the world", async () => {
    open();
    await choose("give");
    // Exact, not a substring: the picker lists "allowcheats" too.
    expect(screen.getByText("cheat")).toBeInTheDocument();
  });

  /*
   * allowcheats is documented as not reversible and regen rewrites a level.
   * One click should not reach them.
   */
  it("makes you type the name of an irreversible command before it can be sent", async () => {
    open();
    await choose("allowcheats");
    const send = screen.getByRole("button", { name: /^send$/i });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/type allowcheats/i), "allowcheats");
    expect(send).toBeEnabled();
  });

  it("reports what was sent, not that it succeeded", async () => {
    open();
    await choose("say");
    await userEvent.type(screen.getByLabelText(/message/i), "hello");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(await screen.findByText(/sent/i)).toBeInTheDocument();
    expect(screen.queryByText(/succeeded|worked|done/i)).not.toBeInTheDocument();
  });

  it("surfaces a refusal from the daemon", async () => {
    const api = makeApi();
    (api.runCommand as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Server is not running (state: stopped)."),
    );
    open(api);
    await choose("say");
    await userEvent.type(screen.getByLabelText(/message/i), "hello");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(await screen.findByText(/not running/i)).toBeInTheDocument();
  });

  it("warns when the table came from a different game version than the one running", async () => {
    open(makeApi("1.4.0", "1.3.1"));
    expect(await screen.findByText(/1\.3\.1/)).toBeInTheDocument();
    expect(screen.getByText(/may be out of date|different version/i)).toBeInTheDocument();
  });

  it("says nothing about versions when they agree", async () => {
    open(makeApi("1.3.1", "1.3.1"));
    await screen.findByRole("combobox", { name: "Command" });
    expect(screen.queryByText(/may be out of date|different version/i)).not.toBeInTheDocument();
  });
});
