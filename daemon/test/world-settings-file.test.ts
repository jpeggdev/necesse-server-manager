import { describe, it, expect } from "vitest";
import { WorldSettingsFile } from "../src/world-settings-file.js";
import { WORLD_SETTINGS_CFG } from "./fixtures/world-zip.js";

describe("WorldSettingsFile round trip", () => {
  /*
   * The load-bearing test of the whole feature. A world's settings file carries
   * comments, tab indentation, trailing commas and keys written by mods; if
   * parsing and re-emitting it is not the identity, then every save silently
   * rewrites parts of the file nobody asked to change - including the
   * `rpgskills*` state the base game has never heard of.
   */
  it("reproduces the real file byte for byte when nothing is changed", () => {
    const file = WorldSettingsFile.parse(WORLD_SETTINGS_CFG);
    expect(file.text()).toBe(WORLD_SETTINGS_CFG);
    expect(Buffer.from(file.text(), "utf8").equals(Buffer.from(WORLD_SETTINGS_CFG, "utf8"))).toBe(true);
  });

  it("round-trips CRLF line endings and a trailing newline", () => {
    const crlf = `${WORLD_SETTINGS_CFG.replace(/\n/g, "\r\n")}\r\n`;
    expect(WorldSettingsFile.parse(crlf).text()).toBe(crlf);
  });

  it("round-trips blank lines and whole-line comments inside the block", () => {
    const odd = ["WORLDSETTINGS = {", "", "\t// a note", "\tallowCheats = false,", "", "}", ""].join("\n");
    const file = WorldSettingsFile.parse(odd);
    expect(file.text()).toBe(odd);
    expect(file.keys()).toEqual(["allowCheats"]);
  });

  it("reads every key in file order, mod keys included", () => {
    const file = WorldSettingsFile.parse(WORLD_SETTINGS_CFG);
    expect(file.keys()).toEqual([
      "allowCheats",
      "difficulty",
      "deathPenalty",
      "raidFrequency",
      "survivalMode",
      "playerHunger",
      "disableMobSpawns",
      "forcedPvP",
      "allowOutsideCharacters",
      "creativeMode",
      "disableMobAI",
      "canSettlersDie",
      "dayTimeMod",
      "nightTimeMod",
      "gameVersion",
      "rpgskillsWorldStackLevel",
      "rpgskillsChestSlotUpgradeLevel",
      "rpgskillsWelcomeMessageShown",
    ]);
  });

  it("reads a value as the file spells it, stopping before the comma and the comment", () => {
    const file = WorldSettingsFile.parse(WORLD_SETTINGS_CFG);
    expect(file.get("difficulty")).toBe("CLASSIC");
    expect(file.get("dayTimeMod")).toBe("1.0");
    expect(file.get("forcedPvP")).toBe("false");
    expect(file.get("gameVersion")).toBe("1.2.0");
    expect(file.get("rpgskillsWelcomeMessageShown")).toBe("1");
    expect(file.get("nothingLikeThis")).toBeUndefined();
  });
});

describe("WorldSettingsFile edits", () => {
  it("changes the one value it was asked to and nothing else in the file", () => {
    const file = WorldSettingsFile.parse(WORLD_SETTINGS_CFG);
    file.set("difficulty", "BRUTAL");
    expect(file.text()).toBe(WORLD_SETTINGS_CFG.replace("difficulty = CLASSIC", "difficulty = BRUTAL"));
  });

  it("keeps the trailing comma and the trailing comment on a line it edits", () => {
    const file = WorldSettingsFile.parse(WORLD_SETTINGS_CFG);
    file.set("forcedPvP", "true");
    file.set("dayTimeMod", "2.5");
    const text = file.text();
    expect(text).toContain("\tforcedPvP = true, // True = players will always have PvP enabled");
    expect(text).toContain(
      "\tdayTimeMod = 2.5, // Day time modifier (The higher, the longer day will last, max 10)",
    );
  });

  it("leaves keys written by a mod untouched across an edit", () => {
    const file = WorldSettingsFile.parse(WORLD_SETTINGS_CFG);
    file.set("allowCheats", "true");
    file.set("raidFrequency", "NEVER");
    const lines = file.text().split("\n");
    expect(lines).toContain("\trpgskillsWorldStackLevel = 1,");
    expect(lines).toContain("\trpgskillsChestSlotUpgradeLevel = 0,");
    expect(lines).toContain("\trpgskillsWelcomeMessageShown = 1");
    // ...and the mod's own values are still readable, so nothing was shifted.
    expect(file.get("rpgskillsWorldStackLevel")).toBe("1");
  });

  it("survives several edits to the same key, keeping the line intact", () => {
    const file = WorldSettingsFile.parse(WORLD_SETTINGS_CFG);
    file.set("dayTimeMod", "10.0");
    file.set("dayTimeMod", "0.5");
    file.set("dayTimeMod", "1.0");
    expect(file.text()).toBe(WORLD_SETTINGS_CFG);
  });

  /*
   * A world whose file has no `maxSettlersPerSettlement` line must not gain
   * one. The game wrote that file; introducing a field it left out is a change
   * to how the world behaves that nobody asked for.
   */
  it("refuses to add a key the file does not already have", () => {
    const file = WorldSettingsFile.parse(WORLD_SETTINGS_CFG);
    expect(() => file.set("maxSettlersPerSettlement", "10")).toThrow(/no "maxSettlersPerSettlement" line/);
    expect(file.text()).toBe(WORLD_SETTINGS_CFG);
  });

  it("refuses a value that would restructure the block rather than change it", () => {
    const file = WorldSettingsFile.parse(WORLD_SETTINGS_CFG);
    for (const bad of ["true,\n\tallowCheats = false", "true // sneaky", "a,b"]) {
      expect(() => file.set("allowCheats", bad)).toThrow(/newline, a comma, or/);
    }
    expect(file.text()).toBe(WORLD_SETTINGS_CFG);
  });
});

describe("WorldSettingsFile refuses files it cannot edit safely", () => {
  it("refuses a file with no WORLDSETTINGS block", () => {
    expect(() => WorldSettingsFile.parse("allowCheats = false\n")).toThrow(/no "WORLDSETTINGS = \{" line/);
  });

  it("refuses a file that declares the same key twice", () => {
    const dup = ["WORLDSETTINGS = {", "\tallowCheats = false,", "\tallowCheats = true", "}"].join("\n");
    expect(() => WorldSettingsFile.parse(dup)).toThrow(/more than once/);
  });

  /*
   * Real and observed: `Test Ville.zip` on this box ends with a mod-written
   * `IncreasedStackSize = ` and nothing after the equals. Dropping the line
   * left GET reporting 18 fields for a 19-key file - the round trip stayed
   * byte-exact, because the splice editor never touched a line it had not
   * recorded, but "every key in the file" was quietly untrue.
   */
  it("keeps a key whose value is empty rather than dropping the line", () => {
    const withEmpty = [
      "WORLDSETTINGS = {",
      "\tallowCheats = false,",
      "\tIncreasedStackSize = ",
      "}",
    ].join("\n");
    const file = WorldSettingsFile.parse(withEmpty);

    expect(file.keys()).toEqual(["allowCheats", "IncreasedStackSize"]);
    expect(file.get("IncreasedStackSize")).toBe("");
    expect(file.has("IncreasedStackSize")).toBe(true);
    expect(file.text()).toBe(withEmpty);
  });

  it("keeps an empty value that still has its comma and its comment", () => {
    const withEmpty = [
      "WORLDSETTINGS = {",
      "\tIncreasedStackSize = , // set by the mod on first load",
      "\tallowCheats = false",
      "}",
    ].join("\n");
    const file = WorldSettingsFile.parse(withEmpty);
    expect(file.get("IncreasedStackSize")).toBe("");
    expect(file.text()).toBe(withEmpty);

    // And writing into that empty span inserts, leaving the comma and comment.
    file.set("IncreasedStackSize", "64");
    expect(file.text()).toContain("\tIncreasedStackSize = 64, // set by the mod on first load");
  });

  it("does not read assignments outside the block", () => {
    const framed = ["allowCheats = true", "WORLDSETTINGS = {", "\tsurvivalMode = true", "}", "difficulty = HARD"].join(
      "\n",
    );
    const file = WorldSettingsFile.parse(framed);
    expect(file.keys()).toEqual(["survivalMode"]);
    expect(file.text()).toBe(framed);
  });
});
