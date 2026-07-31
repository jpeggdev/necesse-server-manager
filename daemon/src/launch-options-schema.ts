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

  int("worldborder", "world", "World border", "Size of the world border. -1 for none.", -1),
  int("itemslife", "world", "Dropped item lifetime", "Minutes a dropped item survives before despawning. 0 for forever.", 0),
  int("unloadlevels", "world", "Unload levels after", "Seconds before an empty level is unloaded from memory.", 2),
  bool("unloadsettlements", "world", "Unload settlements", "Lets settlements unload with their level."),
  int("maxsettlements", "world", "Max settlements per player", "-1 for unlimited.", -1),
  int("maxsettlers", "world", "Max settlers per settlement", "-1 for unlimited.", -1),
  str("language", "world", "Language", "Server language id. An unknown value falls back to the default with a warning."),
];

const BY_NAME: ReadonlyMap<string, LaunchOptionField> = new Map(
  LAUNCH_OPTION_FIELDS.map((f) => [f.name, f]),
);

export function fieldByName(name: string): LaunchOptionField | undefined {
  return BY_NAME.get(name);
}

/**
 * Text the game's own parser would read back as something other than text.
 *
 * `GameLaunch.parseLaunchOptions` does not walk argv element by element. It
 * calls `quoteArgs`, which wraps any element containing a space in double
 * quotes, joins the whole array into ONE string, and scans that string for `-`
 * and `+` tokens with `[^\s"']+|"([^"]*)"|'([^']*)'`. So an `owner` of
 * `-settings C:/evil.cfg` arrives as `-owner "-settings C:/evil.cfg"`; the
 * parser takes the quoted group, sees it starts with `-`, stores `owner` as
 * EMPTY and continues WITHOUT skipping past the quoted region - then finds the
 * `-` inside `-settings` and parses it as a real option. One value both empties
 * the option the operator set and injects a flag this daemon deliberately does
 * not offer, on a process running as SYSTEM. No quote character is required:
 * whitespace followed by `-` or `+` is enough.
 *
 * Refusing at the boundary is the only honest answer, and the consequence is
 * real rather than hidden: a message of the day like `Welcome - have fun`
 * cannot be passed to this game by anything, which is why the message says so.
 * A loud refusal beats a command line that quietly means something else.
 */
const RETOKENISED_BY_THE_GAME = /^[-+]|\s[-+]|["']/;

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
        `"${name}" cannot contain a quote, and no word in it can start with - or +. ` +
        `The game joins the whole command line into one string before it parses it, so a ` +
        `value like that is read back as another flag: it would leave "${name}" empty and ` +
        `set an option nobody asked for. That is a limit of the game's own parser, so text ` +
        `such as "Welcome - have fun" cannot reach this server by any route.`
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
