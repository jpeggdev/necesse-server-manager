import type { LaunchOptionField, LaunchOptionValue } from "./types.js";

/**
 * The server launch options this daemon exposes, and the game's own limits.
 *
 * Read out of the decompiled `necesse.engine.loading.ServerLoader`
 * (`handleLaunchArgs`, plus the `owner` read in `loadGame`), not from
 * documentation. Two properties of that source shape everything here: the game
 * CLAMPS rather than rejecting, and an unparseable integer only warns and keeps
 * the default - so a wrong value never fails a launch, it quietly becomes a
 * different value. That is why `checkLaunchOption` refuses instead of passing
 * things through.
 *
 * `nogui`, `datadir` and `world` are absent on purpose. They are the daemon's
 * own arguments, and their absence from this list is the whole mechanism that
 * stops them being overridden. `settings` and `logs` are absent too: the first
 * would create a second source of truth these options then override, and the
 * second moves a log directory the daemon does not read from anyway.
 */
const str = (
  name: string,
  group: LaunchOptionField["group"],
  label: string,
  help: string,
): LaunchOptionField => ({ name, type: "string", group, label, help });

const bool = (
  name: string,
  group: LaunchOptionField["group"],
  label: string,
  help: string,
): LaunchOptionField => ({ name, type: "boolean", group, label, help });

const int = (
  name: string,
  group: LaunchOptionField["group"],
  label: string,
  help: string,
  min: number,
  max?: number,
): LaunchOptionField => ({ name, type: "int", group, label, help, min, max });

export const LAUNCH_OPTION_FIELDS: readonly LaunchOptionField[] = [
  str("owner", "identity", "Owner", "Any player connecting with this name gets owner permissions. The game supports exactly one."),
  str("motd", "identity", "Message of the day", "Shown to players on connect. \\n becomes a line break."),
  str("password", "identity", "Password", "Players must enter this to join. Leave unset for an open server."),

  int("slots", "capacity", "Player slots", "How many players may be connected at once.", 1, 250),
  int("port", "capacity", "Game port", "The port PLAYERS connect to, not the daemon's. Changing it needs a matching firewall rule or nobody can reach the server.", 0, 65535),
  str("ip", "capacity", "Bind address", "Which local address the server binds to. Leave unset to bind all of them."),

  bool("pausewhenempty", "behaviour", "Pause when empty", "Stops the world ticking while no players are connected."),
  bool("strictserverauthority", "behaviour", "Strict server authority", "The server decides player positions rather than trusting the client."),
  bool("logging", "behaviour", "Server logging", "Writes the server log to disk."),
  bool("zipsaves", "behaviour", "Zip saves", "Stores world saves as zip files."),

  // The three fields below documented -1 as "none"/"unlimited" and declared it
  // as their minimum. A negative number cannot be put on this game's command
  // line at all - probed, see checkLaunchOption - so offering it advertised a
  // value the game can never receive. The minimum is 0 and the help says where
  // the sentinel went, rather than the form silently refusing what it offered.
  int("worldborder", "world", "World border", "Size of the world border. The game's -1 (no border) cannot be sent on a command line, so it is not offered here; leave this unset for the game's own default.", 0),
  int("itemslife", "world", "Dropped item lifetime", "Minutes a dropped item survives before despawning. 0 for forever.", 0),
  int("unloadlevels", "world", "Unload levels after", "Seconds before an empty level is unloaded from memory.", 2),
  bool("unloadsettlements", "world", "Unload settlements", "Lets settlements unload with their level."),
  int("maxsettlements", "world", "Max settlements per player", "The game's -1 (unlimited) cannot be sent on a command line, so it is not offered here; leave this unset for the game's own default.", 0),
  int("maxsettlers", "world", "Max settlers per settlement", "The game's -1 (unlimited) cannot be sent on a command line, so it is not offered here; leave this unset for the game's own default.", 0),
  str("language", "world", "Language", "Server language id. An unknown value falls back to the default with a warning."),
];

const BY_NAME: ReadonlyMap<string, LaunchOptionField> = new Map(
  LAUNCH_OPTION_FIELDS.map((f) => [f.name, f]),
);

export function fieldByName(name: string): LaunchOptionField | undefined {
  return BY_NAME.get(name);
}

/**
 * Text the game's own parser would read back as more than one option.
 *
 * `GameLaunch.parseLaunchOptions` does not walk argv element by element. It
 * calls `quoteArgs`, joins the whole array into ONE string, and walks that
 * string. After it takes an option's value it does NOT advance past it; it
 * resynchronises with
 *
 *   nextOption = Math.max(full.indexOf("-", i), full.indexOf("+", i))
 *
 * which finds a `-` ANYWHERE, including in the middle of a word. So every
 * hyphen in a value starts a new option. This was measured against the real
 * `C:\necesseserver\Server.jar` with a compiled probe, not read off the
 * decompile - an earlier version of this rule only refused a leading `-`/`+`,
 * whitespace-then-`-`/`+`, and quotes, and the probe showed all of these
 * getting through it:
 *
 *   owner  "a-dev"                 -> owner=a-dev                + dev=""
 *   owner  "a-dev 42"              -> owner=a-dev 42             + dev="42"
 *   owner  "x-settings C:/e.cfg"   -> owner=x-settings C:/e.cfg  + settings="C:/e.cfg"
 *   owner  "x-logs C:/evil"        -> owner=x-logs C:/evil       + logs="C:/evil"
 *   owner  "Jean-Luc"              -> owner=Jean-Luc             + Luc=""
 *   motd   "co-op night"           -> motd=co-op night           + op="night"
 *
 * Note the shape: the option the operator set survives INTACT, so the client
 * shows exactly what they typed while a second option they never asked for is
 * also set. `dev`, `settings` and `logs` are all real game options this daemon
 * deliberately withholds, and it runs as SYSTEM.
 *
 * `+` is refused too even though the probe shows a lone `+` inside a value
 * currently does NOT inject (`2+2 is 4` parses cleanly). That is an accident of
 * `Math.max` preferring the later of the two first-occurrences combined with
 * this daemon always appending `-nogui -datadir -world` after the value, so a
 * `-` always exists further right and wins. It is a property of our argument
 * ORDER, not of the value, and `a-dev+x` injects via the `+`. Refusing both
 * keeps this rule true of the value alone.
 *
 * Quotes are refused because they corrupt rather than inject: the probe shows
 * `say "hi"` arriving as `say `.
 *
 * The consequence is real and is documented rather than hidden: an owner name
 * or a message of the day cannot contain a hyphen, and the language ids
 * `pt-BR`, `zh-CN` and `zh-TW` cannot be set through this option at all. That
 * is the game's parser, not this daemon. A loud refusal beats a command line
 * that quietly means something else.
 */
const RETOKENISED_BY_THE_GAME = /[-+"']/;

/**
 * Whitespace that ends a value early.
 *
 * A different failure from the one above, with the same root cause. The game
 * joins its arguments into one string and then splits on whitespace, so a tab
 * or a line break inside a value truncates it: `hello<TAB>world` arrives as
 * `hello` and the rest is dropped, with nothing injected and nothing reported.
 * The operator sets a message of the day, sees no error, and the server has a
 * different one.
 *
 * An ordinary space is fine - the game keeps the rest of the line for a value.
 * The two-character escape `\n` is fine too, and is what the motd field's own
 * help tells the operator to type; the game expands it itself. Only real
 * control characters are refused.
 */
const TRUNCATED_BY_THE_GAME = /[\t\r\n\f\v]/;

/**
 * The largest value the game can read.
 *
 * Everything numeric here lands in a Java int, and anything above this is
 * silently ignored rather than clamped. JavaScript makes it easy to exceed:
 * `Number.isInteger(1e21)` is true, and 1e21 serialises onto the command line
 * as `1e+21`, which the game does not parse as a number at all.
 */
const GAME_INT_MAX = 2147483647;

/**
 * Why this value cannot be stored for this option, or null if it can.
 *
 * An unknown name is refused rather than ignored: silently dropping a key means
 * a user sets something, sees no error, and gets a server that does not have
 * it. This is also the gate that keeps `datadir` and friends out, since they
 * are not in the field list.
 */
export function checkLaunchOption(name: string, value: unknown): string | null {
  const field = fieldByName(name);
  if (field === undefined) {
    return `"${name}" is not a known launch option.`;
  }
  if (field.type === "string") {
    if (typeof value !== "string") return `"${name}" takes text.`;
    if (RETOKENISED_BY_THE_GAME.test(value)) {
      return (
        `"${name}" cannot contain - + " or '. The game joins its whole command line into one ` +
        `string and then looks for the next - or + anywhere in it, including inside a word, so ` +
        `each of those characters starts a new option: "Jean-Luc" sets the owner and also turns ` +
        `on an option called "Luc", and "x-settings C:/evil.cfg" sets the game's real -settings ` +
        `option. Measured against Server.jar. That is a limit of the game's own parser, so text ` +
        `like this cannot reach the server by any route.`
      );
    }
    if (TRUNCATED_BY_THE_GAME.test(value)) {
      return (
        `"${name}" cannot contain a tab or a line break. The game splits its command line on ` +
        `whitespace, so everything from that character onward is dropped: "hello<tab>world" ` +
        `arrives as "hello". Nothing reports it, so the value on the server would quietly differ ` +
        `from the one set here. A plain space is fine, and for a line break in the message of the ` +
        `day type the two characters \\n, which the game expands itself.`
      );
    }
    return null;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") return `"${name}" takes true or false.`;
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return `"${name}" takes a whole number.`;
  }
  // Before the range check, so the reason given is the parser limit rather than
  // a bare "must be 0 or more" that reads like an arbitrary bound. Probed
  // against Server.jar: `-worldborder -1` yields worldborder="" AND an option
  // named "1", because the resync above finds the `-` of the value itself. A
  // negative number is simply not expressible on this game's command line.
  if (value < 0) {
    return (
      `"${name}" cannot be negative. The game reads the leading - as the start of another ` +
      `option, so -1 arrives as an empty "${name}" plus an option called "1". Measured against ` +
      `Server.jar. Leave "${name}" unset to get the game's own default.`
    );
  }
  // Before the per-field bounds: a field with no max of its own still cannot
  // exceed what the game's int can hold, and the reason is the game's type
  // rather than any limit this schema chose.
  if (value > GAME_INT_MAX) {
    return (
      `"${name}" cannot be more than ${GAME_INT_MAX}. The game reads it into an integer of that ` +
      `size and silently ignores anything larger, and a value big enough to be written in ` +
      `exponent form (1e+21) is not read as a number at all.`
    );
  }
  const { min, max } = field;
  if (min !== undefined && max !== undefined && (value < min || value > max)) {
    // Named limits, because the game silently clamps to them rather than
    // reporting anything: without this the UI and the running server disagree.
    return `"${name}" must be between ${min} and ${max}; the game clamps anything outside that.`;
  }
  if (min !== undefined && max === undefined && value < min) {
    return `"${name}" must be ${min} or more; the game clamps anything lower.`;
  }
  return null;
}

/** Daemon-wide defaults with a world's overrides applied on top. */
export function effectiveOptions(
  defaults: Record<string, LaunchOptionValue>,
  overrides: Record<string, LaunchOptionValue>,
): Record<string, LaunchOptionValue> {
  return { ...defaults, ...overrides };
}
