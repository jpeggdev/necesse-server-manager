import { describe, it, expect } from "vitest";
import {
  LAUNCH_OPTION_FIELDS,
  checkLaunchOption,
  effectiveOptions,
  fieldByName,
} from "../src/launch-options-schema.js";

describe("LAUNCH_OPTION_FIELDS", () => {
  it("never exposes an argument the daemon controls", () => {
    // -datadir is what lets the daemon run as SYSTEM and still find the real
    // worlds and mods. A settable one produces a server that starts cleanly
    // against an empty directory and reports success.
    const names = LAUNCH_OPTION_FIELDS.map((f) => f.name);
    for (const forbidden of ["datadir", "world", "nogui", "settings", "logs"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("exposes the options read from ServerLoader", () => {
    const names = LAUNCH_OPTION_FIELDS.map((f) => f.name).sort();
    expect(names).toEqual(
      [
        "ip", "itemslife", "language", "logging", "maxsettlements", "maxsettlers",
        "motd", "owner", "password", "pausewhenempty", "port", "slots",
        "strictserverauthority", "unloadlevels", "unloadsettlements",
        "worldborder", "zipsaves",
      ].sort(),
    );
  });

  it("gives every field a label and help text", () => {
    for (const f of LAUNCH_OPTION_FIELDS) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.help.length).toBeGreaterThan(0);
    }
  });
});

describe("checkLaunchOption", () => {
  it("rejects an unknown option by name", () => {
    expect(checkLaunchOption("nosuchthing", "x")).toMatch(/not a known/i);
  });

  it("accepts a valid value for each type", () => {
    expect(checkLaunchOption("owner", "Jeff")).toBeNull();
    expect(checkLaunchOption("slots", 5)).toBeNull();
    expect(checkLaunchOption("pausewhenempty", true)).toBeNull();
  });

  it("rejects a wrong type, naming what it wanted", () => {
    expect(checkLaunchOption("slots", "five")).toMatch(/whole number/i);
    expect(checkLaunchOption("pausewhenempty", "yes")).toMatch(/true or false/i);
    expect(checkLaunchOption("owner", 7)).toMatch(/text/i);
  });

  it("rejects a non-integer where the game parses an int", () => {
    expect(checkLaunchOption("slots", 5.5)).toMatch(/whole number/i);
  });

  // The game clamps rather than refusing, so an out-of-range value would
  // silently become a different one. These bounds are the game's own.
  it("refuses values outside the game's clamp, naming the limit", () => {
    expect(checkLaunchOption("slots", 0)).toMatch(/1 and 250/);
    expect(checkLaunchOption("slots", 251)).toMatch(/1 and 250/);
    expect(checkLaunchOption("port", -1)).toMatch(/0 and 65535/);
    expect(checkLaunchOption("port", 65536)).toMatch(/0 and 65535/);
    expect(checkLaunchOption("unloadlevels", 1)).toMatch(/2 or more/);
    expect(checkLaunchOption("worldborder", -2)).toMatch(/-1 or more/);
    expect(checkLaunchOption("itemslife", -1)).toMatch(/0 or more/);
    expect(checkLaunchOption("maxsettlements", -2)).toMatch(/-1 or more/);
    expect(checkLaunchOption("maxsettlers", -2)).toMatch(/-1 or more/);
  });

  /*
   * The game joins the whole command line into ONE string (quoteArgs, then
   * GameUtils.join) before scanning it for `-` and `+` tokens, so a text value
   * containing a word that starts with `-` is re-parsed as a flag: the option
   * the operator set is stored empty AND an option that is not on offer here
   * gets set, on a process running as SYSTEM. These pin the boundary refusal.
   */
  describe("text a value the game would re-tokenize", () => {
    it("refuses the exact -settings injection, naming the option", () => {
      const bad = checkLaunchOption("owner", "-settings C:/evil.cfg");
      expect(bad).not.toBeNull();
      expect(bad).toContain('"owner"');
      // The consequence is stated, not just the rule: this is the whole reason
      // refusing is better than emitting the value.
      expect(bad).toMatch(/read back as another flag/i);
    });

    it("refuses a flag word anywhere in the value, not just at the start", () => {
      // No quote character is needed and the value need not start with the
      // flag: whitespace followed by `-` or `+` is all the parser requires.
      expect(checkLaunchOption("motd", "Welcome - have fun")).not.toBeNull();
      expect(checkLaunchOption("motd", "hello -settings C:/evil.cfg")).not.toBeNull();
      expect(checkLaunchOption("motd", "hello +dev")).not.toBeNull();
      expect(checkLaunchOption("password", "-dev")).not.toBeNull();
      expect(checkLaunchOption("ip", "+dev")).not.toBeNull();
      // \s, not just a literal space - the parser's own pattern uses \s.
      expect(checkLaunchOption("motd", "line\n-settings x")).not.toBeNull();
      expect(checkLaunchOption("motd", "tab\t-dev")).not.toBeNull();
    });

    it("refuses quote characters, which quoteArgs and argsPattern both read", () => {
      expect(checkLaunchOption("motd", 'say "hi"')).not.toBeNull();
      expect(checkLaunchOption("motd", "say 'hi'")).not.toBeNull();
    });

    it("still accepts ordinary text, including a hyphen inside a word", () => {
      // The rule is about words STARTING with - or +, so refusing these would
      // be an over-broad filter that made the option unusable.
      expect(checkLaunchOption("owner", "Jeff")).toBeNull();
      expect(checkLaunchOption("owner", "Jean-Luc")).toBeNull();
      expect(checkLaunchOption("motd", "Welcome to the server!")).toBeNull();
      expect(checkLaunchOption("motd", "2+2 is 4")).toBeNull();
      expect(checkLaunchOption("motd", "line\\nbreak")).toBeNull();
      expect(checkLaunchOption("ip", "192.168.1.106")).toBeNull();
      // "" is a real stored value that clears nothing - see applyChanges.
      expect(checkLaunchOption("password", "")).toBeNull();
    });

    it("does not apply the text rule to the other types", () => {
      // -1 is legal for worldborder, maxsettlements and maxsettlers, and the
      // rule must not leak across from strings and refuse them.
      expect(checkLaunchOption("worldborder", -1)).toBeNull();
      expect(checkLaunchOption("maxsettlers", -1)).toBeNull();
    });
  });

  it("accepts the exact edges", () => {
    expect(checkLaunchOption("slots", 1)).toBeNull();
    expect(checkLaunchOption("slots", 250)).toBeNull();
    expect(checkLaunchOption("port", 0)).toBeNull();
    expect(checkLaunchOption("port", 65535)).toBeNull();
    expect(checkLaunchOption("unloadlevels", 2)).toBeNull();
    expect(checkLaunchOption("worldborder", -1)).toBeNull();
    expect(checkLaunchOption("itemslife", 0)).toBeNull();
  });
});

describe("fieldByName", () => {
  it("finds a field and reports an unknown one as undefined", () => {
    expect(fieldByName("slots")?.type).toBe("int");
    expect(fieldByName("datadir")).toBeUndefined();
  });
});

describe("effectiveOptions", () => {
  it("returns defaults when a world overrides nothing", () => {
    expect(effectiveOptions({ owner: "Jeff", slots: 5 }, {})).toEqual({ owner: "Jeff", slots: 5 });
  });

  it("lets a world override a default", () => {
    expect(effectiveOptions({ owner: "Jeff" }, { owner: "Eli" })).toEqual({ owner: "Eli" });
  });

  it("keeps a world-only option that has no default", () => {
    expect(effectiveOptions({}, { motd: "hello" })).toEqual({ motd: "hello" });
  });

  it("does not invent values for options set in neither", () => {
    // Unset means the flag is not passed at all, so the game applies its own
    // default rather than this daemon guessing at one.
    expect(effectiveOptions({}, {})).toEqual({});
  });
});
