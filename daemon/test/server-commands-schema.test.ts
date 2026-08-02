import { describe, it, expect } from "vitest";
import { SERVER_COMMANDS, SCHEMA_GAME_VERSION } from "../src/server-commands-schema.js";

/*
 * The schema is generated from the server's own Server.jar, so these are not
 * testing the extractor's arithmetic - they pin the facts the rest of the
 * feature relies on, and they are what fails if a re-extraction against a new
 * game version changes something load-bearing.
 */
describe("the extracted command schema", () => {
  it("carries a command's real parameter types and optionality", () => {
    const give = SERVER_COMMANDS.find((c) => c.name === "give");
    expect(give).toMatchObject({ permission: "ADMIN", isCheat: true });
    expect(give?.params).toEqual([
      { name: "player", type: "player", optional: true },
      { name: "item", type: "text", optional: false },
      { name: "amount", type: "int", optional: true },
    ]);
  });

  it("resolves a command registered under an alias rather than a literal name", () => {
    // TeleportServerCommand takes its name as a constructor argument; the name
    // only exists at its registration site.
    expect(SERVER_COMMANDS.find((c) => c.name === "tp")).toBeDefined();
    for (const alias of ["w", "pm", "whisper"]) {
      expect(SERVER_COMMANDS.find((c) => c.name === alias), alias).toBeDefined();
    }
  });

  /*
   * Absence IS the enforcement. The daemon owns the server's lifecycle and its
   * stop never escalates to a kill, so a second path to stopping it is a race.
   * A name that is not in this table cannot be composed at all.
   */
  it("omits the commands that would race the daemon's own lifecycle", () => {
    for (const name of ["stop", "exit", "quit"]) {
      expect(SERVER_COMMANDS.find((c) => c.name === name), name).toBeUndefined();
    }
  });

  it("marks the irreversible ones", () => {
    for (const name of ["allowcheats", "regen", "deleteplayer"]) {
      expect(SERVER_COMMANDS.find((c) => c.name === name)?.destructive, name).toBe(true);
    }
    expect(SERVER_COMMANDS.find((c) => c.name === "say")?.destructive).toBeFalsy();
  });

  it("marks the ones that act on a caller the console does not have", () => {
    expect(SERVER_COMMANDS.find((c) => c.name === "die")?.playerOnly).toBe(true);
    expect(SERVER_COMMANDS.find((c) => c.name === "kick")?.playerOnly).toBeFalsy();
  });

  it("keeps the game's own cheat flag, which is where the wiki's (cheats) comes from", () => {
    expect(SERVER_COMMANDS.find((c) => c.name === "give")?.isCheat).toBe(true);
    expect(SERVER_COMMANDS.find((c) => c.name === "players")?.isCheat).toBe(false);
  });

  it("records the game version it was taken from", () => {
    expect(SCHEMA_GAME_VERSION).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });

  it("has unique names, non-empty parameter names, and no unknown parameter types", () => {
    const names = SERVER_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const allowed = new Set(["int", "float", "bool", "enum", "player", "text"]);
    for (const c of SERVER_COMMANDS) {
      expect(c.name.length, c.name).toBeGreaterThan(0);
      for (const p of c.params) {
        expect(p.name.length, `${c.name}.${p.name}`).toBeGreaterThan(0);
        expect(allowed.has(p.type), `${c.name}.${p.name}=${p.type}`).toBe(true);
        if (p.type === "enum") expect(p.values?.length, `${c.name}.${p.name}`).toBeGreaterThan(0);
      }
    }
  });

  /*
   * An optional parameter FOLLOWED by a required one is normal here, not a
   * defect: a leading `player` is routinely optional because the game falls
   * back on context, while what comes after it is mandatory. `give` and
   * `armorset` are both this shape.
   *
   * This is pinned because it kills the obvious composer rule. "An omitted
   * optional may only be trailing" would reject `give iron_bar`, which is the
   * ordinary way that command is used. The composer therefore drops omitted
   * optionals and lets the game resolve the rest by type, exactly as it does
   * for a player typing the command in chat.
   */
  it("has commands whose leading optional is followed by a required parameter", () => {
    const armorset = SERVER_COMMANDS.find((c) => c.name === "armorset");
    expect(armorset?.params.map((p) => [p.name, p.optional])).toEqual([
      ["player", true],
      ["setname", false],
    ]);
  });

  /*
   * A CmdParameter's trailing varargs are FURTHER PARAMETERS, nested inside the
   * one they follow - what the wiki renders as
   * `[<authentication/name> [<permissions>]]`. An extractor that reads only the
   * top-level constructor arguments drops them, and the form then has no field
   * for an argument the command needs: `permissions set Jeff` was accepted and
   * answered by the real server with "Missing permissions" on 2026-08-02.
   */
  it("includes parameters the game nests inside another parameter", () => {
    expect(SERVER_COMMANDS.find((c) => c.name === "permissions")?.params.map((p) => p.name)).toEqual([
      "list/set/get",
      "authentication/name",
      "permissions",
    ]);
  });

  it("flattens a chain of nested parameters in command-line order", () => {
    expect(SERVER_COMMANDS.find((c) => c.name === "rain")?.params.map((p) => p.name)).toEqual([
      "islandX",
      "islandY",
      "dimension",
      "start/clear",
    ]);
  });

  /*
   * Values the jar states outright become a dropdown. These come from three
   * different declarations: an inline preset list, a Java enum reached through
   * PermissionLevelParameterHandler, and a MultiParameterHandler whose
   * alternatives are all closed.
   */
  it("offers the real permission levels rather than a text box", () => {
    const p = SERVER_COMMANDS.find((c) => c.name === "permissions")?.params.find(
      (x) => x.name === "permissions",
    );
    expect(p?.type).toBe("enum");
    expect(p?.values).toEqual(["user", "creativesettings", "moderator", "admin", "owner", "server"]);
  });

  it("unions the alternatives of a parameter that accepts several closed forms", () => {
    const p = SERVER_COMMANDS.find((c) => c.name === "difficulty")?.params[0];
    expect(p?.type).toBe("enum");
    expect(p?.values).toEqual(["list", "casual", "adventure", "classic", "hard", "brutal"]);
  });

  /*
   * The other half of that rule. `tp` accepts a player OR one of a few words,
   * and a player name is not drawn from any list in the jar, so a dropdown
   * would be a lie about what the parameter takes.
   */
  it("leaves a parameter open when any of its alternatives is open", () => {
    const p = SERVER_COMMANDS.find((c) => c.name === "tp")?.params[1];
    expect(p?.type).toBe("text");
    expect(p?.values).toBeUndefined();
  });

  it("covers the whole command set, not a handful", () => {
    expect(SERVER_COMMANDS.length).toBeGreaterThan(80);
  });
});
