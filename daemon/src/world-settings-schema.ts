import type { WorldSettingType } from "./types.js";

/**
 * What this daemon knows about the fields of `necesse.engine.world.WorldSettings`.
 *
 * Field names, types and enum option sets were read out of `Server.jar` with
 * `javap` rather than inferred from a single observed file: a world that
 * happens to sit on `difficulty = CLASSIC` tells you nothing about which other
 * values the game would accept, and a form offering a value the game rejects
 * corrupts a save to find out.
 *
 * This map is NOT the set of keys any particular world has. It is only what a
 * key means if it is present. Real files carry fewer keys than this (a world
 * with no `maxSettlersPerSettlement` line is normal) and also more (mod-written
 * keys such as `rpgskills*`), and both cases are handled by looking each of the
 * file's own keys up here, never by walking this map.
 */
export interface KnownField {
  type: WorldSettingType;
  /** Enum fields only: every value the game accepts, verified from Server.jar. */
  options?: readonly string[];
  /** Numeric fields only, inclusive. */
  min?: number;
  max?: number;
  /**
   * false for a field the game owns. Present in the file, reported by the API,
   * never writable through it.
   */
  editable: boolean;
}

const bool = (): KnownField => ({ type: "boolean", editable: true });

/**
 * The numeric bounds below deserve a word, because only one of them is
 * verified. `dayTimeMod`/`nightTimeMod` are capped at 10 by the file's own
 * comment, which the game wrote. Everything else is a sanity guard chosen here:
 * these are guards against a value that is obviously nonsense (a negative
 * lifetime, a settler cap in the millions), not a claim about where the game's
 * real limits sit. They are deliberately generous so that a legitimate value is
 * never refused, and the floor on the time modifiers excludes 0 because a
 * zero-length day is not a setting anybody means and its in-game behaviour is
 * unverified.
 */
export const WORLD_SETTING_FIELDS: Readonly<Record<string, KnownField>> = {
  allowCheats: bool(),
  survivalMode: bool(),
  playerHunger: bool(),
  canSettlersDie: bool(),
  disableMobSpawns: bool(),
  forcedPvP: bool(),
  allowOutsideCharacters: bool(),
  creativeMode: bool(),
  disableMobAI: bool(),
  unloadSettlements: bool(),

  difficulty: {
    type: "enum",
    options: ["CASUAL", "ADVENTURE", "CLASSIC", "HARD", "BRUTAL"],
    editable: true,
  },
  deathPenalty: {
    type: "enum",
    options: ["NONE", "DROP_MATS", "DROP_MAIN_INVENTORY", "DROP_FULL_INVENTORY", "HARDCORE"],
    editable: true,
  },
  raidFrequency: {
    type: "enum",
    options: ["OFTEN", "OCCASIONALLY", "RARELY", "NEVER"],
    editable: true,
  },

  dayTimeMod: { type: "float", min: 0.1, max: 10, editable: true },
  nightTimeMod: { type: "float", min: 0.1, max: 10, editable: true },

  droppedItemsLifeMinutes: { type: "int", min: 0, max: 10080, editable: true },
  maxSettlementsPerPlayer: { type: "int", min: 0, max: 1000, editable: true },
  maxSettlersPerSettlement: { type: "int", min: 0, max: 1000, editable: true },

  // Written by the game to record which build last saved the world. Editing it
  // would tell the game a lie about its own save format, so it is reported and
  // never accepted.
  gameVersion: { type: "string", editable: false },
};

export type ChangeCheck = { ok: true; text: string } | { ok: false; error: string };

/**
 * Turns one requested change into the exact text that would go into the file,
 * or into the reason it will not. Every rejection names the field and what was
 * wrong with it, because this is the message a person editing a form sees.
 *
 * A number arrives as JSON, so `1` and `1.0` are the same value; a float is
 * re-emitted with a `.0` when it is whole, matching how the game writes them.
 */
export function checkChange(key: string, value: unknown): ChangeCheck {
  const field = WORLD_SETTING_FIELDS[key];
  if (field === undefined) {
    return {
      ok: false,
      error:
        `"${key}" is not a world setting this daemon knows. Keys written by mods are reported ` +
        `by GET but cannot be changed here, because nothing knows what values they accept.`,
    };
  }
  if (!field.editable) {
    return { ok: false, error: `"${key}" is written by the game and can never be changed here.` };
  }
  switch (field.type) {
    case "boolean":
      if (typeof value !== "boolean") {
        return { ok: false, error: `"${key}" must be true or false, not ${describe(value)}.` };
      }
      return { ok: true, text: value ? "true" : "false" };

    case "enum": {
      const options = field.options ?? [];
      if (typeof value !== "string" || !options.includes(value)) {
        return {
          ok: false,
          error: `"${key}" must be one of ${options.join(", ")}, not ${describe(value)}.`,
        };
      }
      return { ok: true, text: value };
    }

    case "int": {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return { ok: false, error: `"${key}" must be a whole number, not ${describe(value)}.` };
      }
      const range = checkRange(key, value, field);
      return range ?? { ok: true, text: String(value) };
    }

    case "float": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: `"${key}" must be a number, not ${describe(value)}.` };
      }
      const range = checkRange(key, value, field);
      return range ?? { ok: true, text: Number.isInteger(value) ? `${value}.0` : String(value) };
    }

    case "string":
      // Unreachable: the only string field is gameVersion, refused above as
      // not editable. Kept so adding an editable string field is a compile
      // error here rather than a silent fallthrough.
      return { ok: false, error: `"${key}" cannot be changed here.` };
  }
}

function checkRange(key: string, value: number, field: KnownField): { ok: false; error: string } | null {
  const { min, max } = field;
  if (min !== undefined && value < min) {
    return { ok: false, error: `"${key}" must be at least ${min}; got ${value}.` };
  }
  if (max !== undefined && value > max) {
    return { ok: false, error: `"${key}" must be at most ${max}; got ${value}.` };
  }
  return null;
}

/**
 * Whether writing `text` where the file currently says `current` would change
 * anything at all. Numbers compare numerically so that a form that hands back
 * the value it was given (`1.0` read, `1` sent) leaves the line untouched
 * instead of rewriting it - an edit that changes nothing must change nothing,
 * right down to the bytes.
 */
export function isSameValue(current: string, text: string, type: WorldSettingType): boolean {
  if (type === "float" || type === "int") {
    const a = Number(current);
    const b = Number(text);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  return current === text;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}
