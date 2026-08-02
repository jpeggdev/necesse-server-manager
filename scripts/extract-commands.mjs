// Extracts the game's server command definitions into daemon/src/server-commands-schema.ts.
//
// Run against a CFR decompile of the SERVER's own Server.jar, not the
// workstation's Necesse.jar and not the wiki: those are different artifacts,
// and the wiki gives argument names without their types. See
// docs/superpowers/specs/2026-08-01-player-tracking-and-commands-design.html.
//
//   node scripts/extract-commands.mjs <decompiled-src-root> <gameVersion>
//
// where <decompiled-src-root> is the directory CFR wrote, containing
// necesse/engine/commands/.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , SRC_ROOT, GAME_VERSION] = process.argv;
if (!SRC_ROOT || !GAME_VERSION) {
  console.error("usage: node scripts/extract-commands.mjs <decompiled-src-root> <gameVersion>");
  process.exit(2);
}

const COMMANDS_DIR = join(SRC_ROOT, "necesse", "engine", "commands");
const SERVER_COMMANDS_DIR = join(COMMANDS_DIR, "serverCommands");

/*
 * Policy, applied here rather than by hand in the generated file so it survives
 * a re-extraction against a future game version.
 */

// The daemon owns the server's lifecycle and its stop deliberately never
// escalates to a kill. These are omitted from the schema entirely, so no
// client can name one - the same mechanism that keeps nogui/datadir/world out
// of the launch options.
const EXCLUDED = new Set(["stop", "exit", "quit"]);

// Irreversible or destructive enough to be worth typing the name to confirm.
const DESTRUCTIVE = new Set(["allowcheats", "regen", "deleteplayer", "clearall", "clearmobs", "clearevents"]);

// These act on the caller. There is no caller when the console sends them.
const PLAYER_ONLY = new Set([
  "die", "me", "copyitem", "reveal", "mow", "playtime", "mypermissions",
  "createteam", "leaveteam", "invite", "network", "performance",
]);

/**
 * Maps a parameter handler class to the control the form should render.
 *
 * Deliberately coarse. The registry-backed handlers (item, buff, biome, tile,
 * team, settler, level identifier) cannot have their valid values listed
 * statically, so they are text and the server rejects a bad one and says why.
 * A fake dropdown would be worse than an honest text box.
 */
const HANDLER_TYPES = {
  IntParameterHandler: "int",
  RelativeIntParameterHandler: "text", // accepts relative forms like ~5, so not a number input
  FloatParameterHandler: "float",
  BoolParameterHandler: "bool",
  StringParameterHandler: "text", // may carry preset values; detected below
  PresetStringParameterHandler: "text", // same
  RestStringParameterHandler: "text",
  ServerClientParameterHandler: "player",
  StoredPlayerParameterHandler: "text",
  ItemParameterHandler: "text",
  BuffParameterHandler: "text",
  EnchantmentParameterHandler: "text",
  TileParameterHandler: "text",
  TeamParameterHandler: "text",
  SettlerParameterHandler: "text",
  ArmorSetParameterHandler: "text",
  BiomeParameterHandler: "text",
  LevelIdentifierParameterHandler: "text",
  PermissionLevelParameterHandler: "text",
  EnumParameterHandler: "text",
  MultiParameterHandler: "text",
  UnbanParameterHandler: "text",
  LanguageParameterHandler: "text",
  HelpFormParameterHandler: "text",
  CmdNameParameterHandler: "text",
};

/** Splits an argument list on top-level commas, respecting nesting and strings. */
function splitArgs(src) {
  const out = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current = "";
  for (const ch of src) {
    if (inString) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}

/** The text inside `call(` ... `)`, balanced. Returns null when absent. */
function argsOf(src, callStart) {
  const open = src.indexOf("(", callStart);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

const stringLiteral = (s) => {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s.trim());
  return m === null ? null : m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
};

/** Every double-quoted literal in an expression, in order. */
function literalsIn(src) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/**
 * The constants of a decompiled Java enum, lowercased.
 *
 * The game matches these with `equalsIgnoreCase` and its own autocomplete
 * offers them lowercased, so that is the form to put in front of an operator.
 *
 * Enum-backed parameters are the ones whose values ARE knowable statically,
 * unlike the registry-backed ones (items, buffs, tiles) that only exist once
 * the game has loaded. Leaving these as free text made the operator guess at a
 * closed set the jar states outright.
 */
const enumCache = new Map();
function enumValues(className) {
  if (enumCache.has(className)) return enumCache.get(className);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".java")) files.push(full);
    }
  };
  walk(join(SRC_ROOT, "necesse"));

  // A top-level enum is a file of its own; a nested one (RaidDir inside
  // SettlementRaidLevelEvent) is a declaration inside its outer class, so both
  // shapes have to be looked for.
  const declaration = new RegExp(`enum\\s+${className}\\s*(?:implements[^{]*)?\\{`);
  const own = files.find((f) => f.endsWith(`${className}.java`));
  const holder = own ?? files.find((f) => declaration.test(readFileSync(f, "utf8")));
  if (holder === undefined) {
    throw new Error(
      `Could not find enum ${className} under the decompile. Decompile the class that declares it, or the form will offer no values for a closed set.`,
    );
  }

  const src = readFileSync(holder, "utf8");
  const at = declaration.exec(src);
  const start = at === null ? src.indexOf("{") : at.index + at[0].length - 1;
  // Constants run from the opening brace to the first semicolon after it.
  const body = src.slice(start, src.indexOf(";", start));
  const values = [];
  // Mixed case, not just SCREAMING_CASE: RaidDir's constants are NorthWest,
  // North, SouthEast and so on.
  for (const m of body.matchAll(/^\s+([A-Z][A-Za-z0-9_]*)\s*[(,{]/gm)) values.push(m[1].toLowerCase());
  if (values.length === 0) {
    throw new Error(`Found enum ${className} but read no constants from it.`);
  }
  enumCache.set(className, values);
  return values;
}

function parseHandler(expr) {
  const m = /^new\s+([A-Za-z0-9_]+)\s*\(/.exec(expr.trim());
  if (m === null) return { type: "text", values: [] };
  const cls = m[1];
  const type = HANDLER_TYPES[cls];
  if (type === undefined) {
    // Loud rather than silent: a new parameter type in a future game version
    // must be a build failure, not a form that renders the wrong control.
    throw new Error(
      `Unrecognised parameter handler "${cls}". Add it to HANDLER_TYPES in scripts/extract-commands.mjs.`,
    );
  }
  // Several sources of a closed set, in order of how the game declares it.
  let values = [];
  if (cls === "MultiParameterHandler") {
    /*
     * A parameter that accepts any of several forms. Its values are a closed
     * set only when EVERY alternative is closed: `difficulty` is
     * Multi(Preset("list"), Enum(GameDifficulty)) and can be a dropdown, while
     * `tp` is Multi(ServerClient, String("spawn","home","death")) and cannot,
     * because a player name is not drawn from any list the jar states.
     */
    const inner = argsOf(expr, expr.indexOf("MultiParameterHandler"));
    const children = splitArgs(inner ?? "")
      .filter((a) => a.trim().startsWith("new "))
      .map(parseHandler);
    if (children.length > 0 && children.every((c) => c.values.length > 0)) {
      const union = [];
      for (const c of children) {
        for (const v of c.values) if (!union.includes(v)) union.push(v);
      }
      values = union;
    }
  } else if (cls === "PresetStringParameterHandler" || cls === "StringParameterHandler") {
    // Declared inline as string literals.
    values = literalsIn(expr);
  } else if (cls === "PermissionLevelParameterHandler") {
    // Always the whole PermissionLevel enum: the handler's parse() walks
    // values() and its autocomplete offers all of them unfiltered, reserved
    // ones included, so listing fewer would disagree with the game.
    values = enumValues("PermissionLevel");
  } else if (cls === "EnumParameterHandler") {
    // Always constructed as `(Enum[])SomeEnum.values()`; a nested enum arrives
    // as `Outer.Inner.values()` and is filed under its own name.
    const m = /(?:[A-Za-z0-9_]+\.)*([A-Za-z0-9_]+)\.values\(\)/.exec(expr);
    if (m === null) {
      throw new Error(`EnumParameterHandler with no resolvable enum: ${expr}`);
    }
    values = enumValues(m[1]);
  }
  return { type: values.length > 0 ? "enum" : type, values };
}

/**
 * One CmdParameter and everything nested inside it, flattened in command-line
 * order.
 *
 * A CmdParameter's trailing varargs are FURTHER PARAMETERS, not metadata: the
 * game nests each one inside the parameter it follows, which is what the wiki
 * renders as `[<authentication/name> [<permissions>]]`. Reading only the
 * top-level constructor arguments silently drops them, and the form then has no
 * field for an argument the command genuinely needs - `permissions set <name>`
 * with no level is accepted by the daemon and answered by the game with
 * "Missing permissions".
 */
function parseParams(expr) {
  const inner = argsOf(expr, expr.indexOf("CmdParameter"));
  if (inner === null) return [];
  const parts = splitArgs(inner);
  const name = stringLiteral(parts[0] ?? "");
  if (name === null) return [];
  const handler = parseHandler(parts[1] ?? "");

  // Overloads: (name, handler), (name, handler, extras...),
  // (name, handler, optional, extras...),
  // (name, handler, optional, partOfUsage, extras...)
  // Booleans before the first nested CmdParameter are the flags, in that order.
  let optional = false;
  let seenFlags = 0;
  const nested = [];
  for (const part of parts.slice(2)) {
    const t = part.trim();
    if (t.includes("new CmdParameter(")) {
      nested.push(...parseParams(part));
      continue;
    }
    // `new CmdParameter[0]` is an empty varargs array, not a parameter.
    if (t.startsWith("new CmdParameter[")) continue;
    if (t === "true" || t === "false") {
      if (seenFlags === 0) optional = t === "true";
      seenFlags += 1;
    }
  }

  // A nested parameter can only be supplied when its parent was, so it is
  // optional whatever its own flag says.
  return [
    { name, type: handler.type, optional, values: handler.values },
    ...nested.map((n) => ({ ...n, optional: true })),
  ];
}

/** Names a class is registered under, for the six that take their name as an argument. */
function registeredNames(managerSrc) {
  const byClass = new Map();
  const re = /new\s+([A-Za-z0-9_]+)\s*\(\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(managerSrc)) !== null) {
    const list = byClass.get(m[1]) ?? [];
    list.push(m[2]);
    byClass.set(m[1], list);
  }
  return byClass;
}

const managerSrc = readFileSync(join(COMMANDS_DIR, "CommandsManager.java"), "utf8");
const aliases = registeredNames(managerSrc);

const commands = [];
const skipped = [];
for (const file of readdirSync(SERVER_COMMANDS_DIR).filter((f) => f.endsWith(".java"))) {
  const src = readFileSync(join(SERVER_COMMANDS_DIR, file), "utf8");
  if (!src.includes("extends ModularChatCommand")) {
    skipped.push(`${file}: not a ModularChatCommand`);
    continue;
  }
  const superAt = src.indexOf("super(");
  if (superAt < 0) {
    skipped.push(`${file}: no super() call`);
    continue;
  }
  const args = splitArgs(argsOf(src, superAt) ?? "");
  const cls = file.replace(/\.java$/, "");

  const literalName = stringLiteral(args[0] ?? "");
  const names = literalName !== null ? [literalName] : (aliases.get(cls) ?? []);
  if (names.length === 0) {
    skipped.push(`${cls}: name is not a literal and no registration was found`);
    continue;
  }

  const description = stringLiteral(args[1] ?? "") ?? "";
  const permission = (/PermissionLevel\.([A-Z]+)/.exec(args[2] ?? "") ?? [])[1] ?? "ADMIN";
  const isCheat = (args[3] ?? "").trim() === "true";
  const params = args
    .slice(4)
    .filter((a) => a.includes("new CmdParameter("))
    .flatMap(parseParams);

  for (const name of names) {
    if (EXCLUDED.has(name)) continue;
    commands.push({
      name,
      description,
      permission,
      isCheat,
      params,
      destructive: DESTRUCTIVE.has(name),
      playerOnly: PLAYER_ONLY.has(name),
    });
  }
}

commands.sort((a, b) => a.name.localeCompare(b.name));

const body = commands
  .map((c) => {
    const params = c.params
      .map((p) => {
        const values = p.values.length > 0 ? `, values: [${p.values.map((v) => JSON.stringify(v)).join(", ")}]` : "";
        return `      { name: ${JSON.stringify(p.name)}, type: ${JSON.stringify(p.type)}, optional: ${p.optional}${values} },`;
      })
      .join("\n");
    const flags = [c.destructive ? "    destructive: true," : "", c.playerOnly ? "    playerOnly: true," : ""]
      .filter((s) => s.length > 0)
      .join("\n");
    return [
      "  {",
      `    name: ${JSON.stringify(c.name)},`,
      `    description: ${JSON.stringify(c.description)},`,
      `    permission: ${JSON.stringify(c.permission)},`,
      `    isCheat: ${c.isCheat},`,
      flags,
      c.params.length === 0 ? "    params: []," : `    params: [\n${params}\n    ],`,
      "  },",
    ]
      .filter((s) => s.length > 0)
      .join("\n");
  })
  .join("\n");

const out = `// GENERATED by scripts/extract-commands.mjs from the server's own Server.jar.
// Do not edit by hand: re-run the extractor against the new jar instead.
//
// The single source of truth for which commands exist, what they take, and
// which of them this daemon will send - in the same spirit as
// LAUNCH_OPTION_FIELDS. Extracted rather than transcribed from the wiki
// because the game declares its parameters with types and optionality and the
// wiki does not.
//
// stop, exit and quit are absent on purpose. The daemon owns the server's
// lifecycle and its stop never escalates to a kill, so a second path to
// stopping it is a race, not a feature. Absence is the enforcement: a name
// that is not here cannot be composed.
import type { CommandDef } from "./types.js";

/** The game version this table was taken from. Compared against the running server. */
export const SCHEMA_GAME_VERSION = ${JSON.stringify(GAME_VERSION)};

export const SERVER_COMMANDS: readonly CommandDef[] = [
${body}
];
`;

const target = join(process.cwd(), "daemon", "src", "server-commands-schema.ts");
writeFileSync(target, out, "utf8");
console.log(`wrote ${commands.length} commands to ${target} (game ${GAME_VERSION})`);
if (skipped.length > 0) {
  console.log("skipped:");
  for (const s of skipped) console.log(`  ${s}`);
}
