import { describe, it, expect } from "vitest";
import { composeCommand } from "../src/command-line.js";

describe("composeCommand", () => {
  it("composes a command with all its arguments in declaration order", () => {
    expect(composeCommand("give", { player: "eli", item: "iron_bar", amount: "10" })).toBe(
      "give eli iron_bar 10",
    );
  });

  it("composes a command that takes nothing", () => {
    expect(composeCommand("players", {})).toBe("players");
  });

  it("omits a trailing optional that was not supplied", () => {
    expect(composeCommand("kick", { player: "eli" })).toBe("kick eli");
  });

  /*
   * A leading optional followed by a required parameter is a real shape in this
   * game (give, armorset): the player defaults to context. Rejecting the gap
   * would reject `give iron_bar`, which is the ordinary way the command is
   * used, so an omitted optional is simply dropped and the game resolves the
   * rest by type - exactly as it does for somebody typing it in chat.
   */
  it("drops an omitted leading optional rather than refusing the gap", () => {
    expect(composeCommand("give", { item: "iron_bar", amount: "10" })).toBe("give iron_bar 10");
    expect(composeCommand("armorset", { setname: "copper" })).toBe("armorset copper");
  });

  it("sends no leading slash, which is the form the console takes", () => {
    expect(composeCommand("players", {})).not.toMatch(/^\//);
  });

  it("refuses an unknown command by name", () => {
    expect(() => composeCommand("definitelynotacommand", {})).toThrow(/not a server command/i);
  });

  /*
   * stop/exit/quit are absent from the schema entirely, so this is the SAME
   * failure as an unknown name. That is the enforcement: there is no branch to
   * bypass, because there is nothing to look up.
   */
  it("refuses a command the daemon deliberately does not expose", () => {
    for (const name of ["stop", "exit", "quit"]) {
      expect(() => composeCommand(name, {}), name).toThrow(/not a server command/i);
    }
  });

  it("refuses a missing required argument, naming it", () => {
    expect(() => composeCommand("give", { player: "eli" })).toThrow(/item/);
  });

  it("refuses an argument the command does not have, naming it", () => {
    expect(() => composeCommand("kick", { player: "eli", nonsense: "x" })).toThrow(/nonsense/);
  });

  it("refuses a non-numeric value for an int parameter, naming it", () => {
    expect(() => composeCommand("give", { player: "eli", item: "iron_bar", amount: "ten" })).toThrow(
      /amount/,
    );
  });

  it("refuses a non-boolean value for a bool parameter", () => {
    expect(() => composeCommand("pausewhenempty", { "0/1": "maybe" })).toThrow(/0\/1/);
    expect(composeCommand("pausewhenempty", { "0/1": "1" })).toBe("pausewhenempty 1");
    expect(composeCommand("pausewhenempty", { "0/1": "true" })).toBe("pausewhenempty true");
  });

  /*
   * stdin is line-oriented, so a value carrying a newline runs as a second
   * command: `say hello\nallowcheats` would enable cheats irreversibly.
   * ProcessManager.send refuses these too, but this is the layer that can say
   * WHICH argument was wrong.
   */
  it("refuses control whitespace in a value, naming the parameter", () => {
    expect(() => composeCommand("say", { message: "hello\nallowcheats" })).toThrow(/message/);
    expect(() => composeCommand("say", { message: "hello\rallowcheats" })).toThrow(/message/);
    expect(() => composeCommand("say", { message: "hello\tworld" })).toThrow(/message/);
  });

  it("keeps an ordinary sentence intact for a rest-of-line parameter", () => {
    expect(composeCommand("say", { message: "server going down in 5" })).toBe(
      "say server going down in 5",
    );
  });

  it("refuses an empty value for a required argument rather than sending a gap", () => {
    expect(() => composeCommand("say", { message: "   " })).toThrow(/message/);
  });

  it("refuses a value outside an enum's declared set, naming the allowed ones", () => {
    expect(composeCommand("permissions", { "list/set/get": "list" })).toBe("permissions list");
    expect(() => composeCommand("permissions", { "list/set/get": "sideways" })).toThrow(/list/);
  });

  it("checks a level against the real PermissionLevel enum", () => {
    expect(
      composeCommand("permissions", { "list/set/get": "set", "authentication/name": "Jeff", permissions: "owner" }),
    ).toBe("permissions set Jeff owner");
    expect(() =>
      composeCommand("permissions", { "list/set/get": "set", "authentication/name": "Jeff", permissions: "god" }),
    ).toThrow(/owner/);
  });

  /*
   * Registry-backed values are the ones that stay open: an item id exists only
   * once the game has loaded its registries, so nothing in the jar states the
   * set and the server is what rejects a bad one.
   */
  it("leaves a value alone when the game does not declare the allowed set", () => {
    expect(composeCommand("give", { item: "anything_at_all" })).toBe("give anything_at_all");
  });
});
