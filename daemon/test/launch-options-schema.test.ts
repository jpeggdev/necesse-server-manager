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
    expect(checkLaunchOption("port", 65536)).toMatch(/0 and 65535/);
    expect(checkLaunchOption("unloadlevels", 1)).toMatch(/2 or more/);
    // The negative cases that used to live here now hit the negative-number
    // rule first, which explains the parser limit instead of naming a bound;
    // they are asserted under "negative numbers" below.
  });

  /*
   * The game joins the whole command line into ONE string (quoteArgs, then
   * GameUtils.join) and then walks it, resyncing after each value with
   * Math.max(indexOf("-", i), indexOf("+", i)) - which finds a `-` ANYWHERE,
   * including inside a word. So any hyphen in a text value starts a second
   * option, reaching `dev`, `settings` and `logs` on a process running as
   * SYSTEM. These pin the boundary refusal.
   */
  describe("text a value the game would re-tokenize", () => {
    it("refuses the exact -settings injection, naming the option", () => {
      const bad = checkLaunchOption("owner", "-settings C:/evil.cfg");
      expect(bad).not.toBeNull();
      expect(bad).toContain('"owner"');
      // The consequence is stated, not just the rule: this is the whole reason
      // refusing is better than emitting the value.
      expect(bad).toMatch(/starts a new option/i);
    });

    it("refuses a flag word anywhere in the value, not just at the start", () => {
      expect(checkLaunchOption("motd", "Welcome - have fun")).not.toBeNull();
      expect(checkLaunchOption("motd", "hello -settings C:/evil.cfg")).not.toBeNull();
      expect(checkLaunchOption("motd", "hello +dev")).not.toBeNull();
      expect(checkLaunchOption("password", "-dev")).not.toBeNull();
      expect(checkLaunchOption("ip", "+dev")).not.toBeNull();
      expect(checkLaunchOption("motd", "line\n-settings x")).not.toBeNull();
      expect(checkLaunchOption("motd", "tab\t-dev")).not.toBeNull();
    });

    /*
     * These six were measured against the real C:\necesseserver\Server.jar with
     * a compiled probe, and every one of them defeated the first version of
     * this rule (leading `-`/`+`, whitespace-then-`-`/`+`, quotes). After the
     * parser takes a value it resyncs with
     * Math.max(indexOf("-", i), indexOf("+", i)), which finds a hyphen INSIDE a
     * word, so the option is set correctly AND a second one appears. `dev`,
     * `settings` and `logs` are real options this daemon withholds, on a
     * process running as SYSTEM.
     *
     * `Jean-Luc` and `co-op night` were previously asserted here as SAFE. They
     * are not. Inverted rather than deleted so the hole cannot come back.
     */
    it.each([
      ["owner", "a-dev", "dev="],
      ["owner", "a-dev 42", "dev=42"],
      ["owner", "x-settings C:/evil.cfg", "settings=C:/evil.cfg"],
      ["owner", "x-logs C:/evil", "logs=C:/evil"],
      ["owner", "Jean-Luc", "Luc="],
      ["motd", "co-op night", "op=night"],
    ])("refuses %s=%j, which the real parser turns into an extra %s", (name, value) => {
      expect(checkLaunchOption(name, value)).not.toBeNull();
    });

    it("refuses quote characters, which quoteArgs and argsPattern both read", () => {
      // Probed: `say "hi"` reaches the game as `say `, so this corrupts rather
      // than injects - still not what the operator typed.
      expect(checkLaunchOption("motd", 'say "hi"')).not.toBeNull();
      expect(checkLaunchOption("motd", "say 'hi'")).not.toBeNull();
    });

    it("refuses a plus inside a word even though a lone one currently parses cleanly", () => {
      // The probe shows `2+2 is 4` surviving intact, but only because Math.max
      // prefers the later of the two first-occurrences and buildArgs always
      // appends `-nogui -datadir -world` after the value, so a `-` always wins.
      // That is a property of our argument ORDER, not of the value: `a-dev+x`
      // injects through the `+`. The rule stays true of the value alone.
      expect(checkLaunchOption("motd", "2+2 is 4")).not.toBeNull();
      expect(checkLaunchOption("owner", "a+dev")).not.toBeNull();
    });

    it("still accepts ordinary text with none of those characters", () => {
      // The paired positive control: without it, a checker that refused every
      // string would pass every assertion above.
      expect(checkLaunchOption("owner", "Jeff")).toBeNull();
      expect(checkLaunchOption("owner", "Jean_Luc")).toBeNull();
      expect(checkLaunchOption("motd", "Welcome to the server!")).toBeNull();
      expect(checkLaunchOption("motd", "Hi. Welcome.")).toBeNull();
      expect(checkLaunchOption("motd", "line\\nbreak")).toBeNull();
      expect(checkLaunchOption("ip", "192.168.1.106")).toBeNull();
      expect(checkLaunchOption("language", "en")).toBeNull();
      // "" is a real stored value that clears nothing - see applyChanges.
      expect(checkLaunchOption("password", "")).toBeNull();
    });

    it("refuses the hyphenated language ids, which is a real loss and not a bug", () => {
      // pt-BR, zh-CN and zh-TW are three of the 29 locales shipped in
      // C:\necesseserver\locale. They genuinely cannot be set through this
      // option; documented in README rather than left for a user to discover.
      expect(checkLaunchOption("language", "pt-BR")).not.toBeNull();
      expect(checkLaunchOption("language", "zh-CN")).not.toBeNull();
      expect(checkLaunchOption("language", "zh-TW")).not.toBeNull();
    });
  });

  /*
   * Probed: `-worldborder -1` reaches the game as worldborder="" plus an
   * option named "1", because the parser's resync finds the `-` of the value.
   * A negative number cannot be expressed on this command line at all, so the
   * schema must not offer one.
   */
  describe("negative numbers", () => {
    it("refuses a negative value, explaining the parser limit", () => {
      const bad = checkLaunchOption("worldborder", -1);
      expect(bad).toMatch(/cannot be negative/i);
      expect(bad).toMatch(/option called "1"/);
      expect(checkLaunchOption("maxsettlers", -1)).not.toBeNull();
      expect(checkLaunchOption("maxsettlements", -1)).not.toBeNull();
      expect(checkLaunchOption("worldborder", -5000)).not.toBeNull();
    });

    it("no longer advertises -1 as a legal minimum on any field", () => {
      // The three fields that declared min -1 were the schema promising a value
      // the game cannot receive. Pinned so it cannot be reintroduced.
      for (const f of LAUNCH_OPTION_FIELDS) {
        if (f.type !== "int") continue;
        expect(f.min).toBeGreaterThanOrEqual(0);
        expect(f.help).not.toMatch(/-1 for/);
      }
    });

    it("still accepts 0 and positive values on those fields", () => {
      expect(checkLaunchOption("worldborder", 0)).toBeNull();
      expect(checkLaunchOption("worldborder", 5000)).toBeNull();
      expect(checkLaunchOption("maxsettlers", 0)).toBeNull();
      expect(checkLaunchOption("maxsettlements", 12)).toBeNull();
    });
  });

  it("accepts the exact edges", () => {
    expect(checkLaunchOption("slots", 1)).toBeNull();
    expect(checkLaunchOption("slots", 250)).toBeNull();
    expect(checkLaunchOption("port", 0)).toBeNull();
    expect(checkLaunchOption("port", 65535)).toBeNull();
    expect(checkLaunchOption("unloadlevels", 2)).toBeNull();
    expect(checkLaunchOption("worldborder", 0)).toBeNull();
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
