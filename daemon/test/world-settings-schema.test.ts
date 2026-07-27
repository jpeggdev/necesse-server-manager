import { describe, it, expect } from "vitest";
import { checkChange, isSameValue, WORLD_SETTING_FIELDS } from "../src/world-settings-schema.js";

/**
 * The field table is the only thing standing between a form and a value the
 * game does not accept, so what it accepts and refuses is pinned here directly
 * rather than only through the routes.
 */
describe("checkChange", () => {
  const accepted = (key: string, value: unknown): string => {
    const r = checkChange(key, value);
    if (!r.ok) throw new Error(`expected ${key}=${JSON.stringify(value)} to be accepted: ${r.error}`);
    return r.text;
  };

  it("writes booleans as the game spells them", () => {
    expect(accepted("allowCheats", true)).toBe("true");
    expect(accepted("survivalMode", false)).toBe("false");
  });

  it("accepts every option of every enum, and only those", () => {
    for (const key of ["difficulty", "deathPenalty", "raidFrequency"]) {
      const options = WORLD_SETTING_FIELDS[key].options ?? [];
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) expect(accepted(key, option)).toBe(option);
      // Case matters: the game's parser reads these as enum constants.
      expect(checkChange(key, options[0].toLowerCase()).ok).toBe(false);
    }
  });

  it("writes a whole float the way the game does, and keeps a fractional one", () => {
    expect(accepted("dayTimeMod", 3)).toBe("3.0");
    expect(accepted("dayTimeMod", 2.5)).toBe("2.5");
  });

  it("holds the time modifiers to the cap the game itself documents", () => {
    expect(accepted("dayTimeMod", 10)).toBe("10.0");
    expect(checkChange("nightTimeMod", 10.1)).toMatchObject({ ok: false, error: /at most 10/ });
    expect(checkChange("dayTimeMod", 0)).toMatchObject({ ok: false, error: /at least 0\.1/ });
    expect(checkChange("dayTimeMod", -1)).toMatchObject({ ok: false, error: /at least 0\.1/ });
  });

  /*
   * -1 is not an out-of-range number here. Necesse's server.cfg documents the
   * sibling settlement caps as "-1 or less means infinite", so it is a value a
   * person will genuinely type, and refusing it would be this daemon inventing
   * a restriction the game does not have.
   */
  it("accepts -1 on the int fields as the documented infinite sentinel", () => {
    for (const key of [
      "droppedItemsLifeMinutes",
      "maxSettlementsPerPlayer",
      "maxSettlersPerSettlement",
    ]) {
      expect(accepted(key, -1), key).toBe("-1");
      expect(accepted(key, 0), key).toBe("0");
      expect(checkChange(key, -2), key).toMatchObject({ ok: false, error: /at least -1/ });
    }
  });

  it("refuses a number where a whole one is required", () => {
    expect(checkChange("maxSettlersPerSettlement", 1.5)).toMatchObject({
      ok: false,
      error: /whole number/,
    });
  });

  it("refuses values of the wrong shape entirely", () => {
    expect(checkChange("allowCheats", "true")).toMatchObject({ ok: false, error: /true or false/ });
    expect(checkChange("allowCheats", null)).toMatchObject({ ok: false, error: /not null/ });
    expect(checkChange("difficulty", ["HARD"])).toMatchObject({ ok: false, error: /an array/ });
    expect(checkChange("dayTimeMod", Number.NaN)).toMatchObject({ ok: false, error: /must be a number/ });
    expect(checkChange("dayTimeMod", Number.POSITIVE_INFINITY)).toMatchObject({ ok: false });
  });

  it("never lets gameVersion be written, whatever the value looks like", () => {
    for (const value of ["1.2.0", "9.9.9", 1, true, null]) {
      expect(checkChange("gameVersion", value), String(value)).toMatchObject({
        ok: false,
        error: /written by the game/,
      });
    }
  });

  it("refuses a key it does not know, including a mod's", () => {
    expect(checkChange("rpgskillsWorldStackLevel", 2)).toMatchObject({
      ok: false,
      error: /not a world setting this daemon knows/,
    });
    expect(checkChange("__proto__", true).ok).toBe(false);
    expect(checkChange("constructor", true).ok).toBe(false);
  });
});

describe("isSameValue", () => {
  // An edit that changes nothing must change nothing, right down to the bytes:
  // a form handing back the `1.0` it was shown as `1` must not rewrite the zip.
  it("compares numbers numerically so a re-sent value is a no-op", () => {
    expect(isSameValue("1.0", "1.0", "float")).toBe(true);
    expect(isSameValue("1.0", "1", "float")).toBe(true);
    expect(isSameValue("1", "1.0", "int")).toBe(true);
    expect(isSameValue("1.0", "2.0", "float")).toBe(false);
  });

  it("compares everything else exactly", () => {
    expect(isSameValue("CLASSIC", "CLASSIC", "enum")).toBe(true);
    expect(isSameValue("CLASSIC", "HARD", "enum")).toBe(false);
    expect(isSameValue("true", "true", "boolean")).toBe(true);
    expect(isSameValue("true", "false", "boolean")).toBe(false);
  });

  // An unparseable current value must never read as "same", or a world whose
  // file holds something odd would quietly refuse to be corrected.
  it("does not call an unreadable current value equal to anything", () => {
    expect(isSameValue("", "1.0", "float")).toBe(false);
    expect(isSameValue("lots", "5", "int")).toBe(false);
  });
});
