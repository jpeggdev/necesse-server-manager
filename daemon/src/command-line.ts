import { SERVER_COMMANDS } from "./server-commands-schema.js";
import type { CommandDef, CommandParam } from "./types.js";

/**
 * Control whitespace that would break a command into two.
 *
 * stdin is line-oriented, so a value carrying a newline runs as a second
 * command - `say hello\nallowcheats` would enable cheats irreversibly. A tab is
 * refused for a quieter reason measured on the real server: the game splits its
 * command line on whitespace, so a tab inside a value silently truncates it.
 */
const CONTROL_WHITESPACE = /[\r\n\t]/;

const BOOLEANS = new Set(["0", "1", "true", "false"]);

const find = (name: string): CommandDef | undefined =>
  SERVER_COMMANDS.find((c) => c.name === name);

/**
 * Checks one supplied value against what its parameter accepts.
 *
 * Returns the reason it is unacceptable, or null. Registry-backed values (an
 * item id, a buff, a team) are not checked here at all: their valid sets are
 * the game's own registries, so the server is the only thing that can judge
 * them, and it says why when it refuses.
 */
function reject(param: CommandParam, value: string): string | null {
  if (CONTROL_WHITESPACE.test(value)) {
    return `${param.name} cannot contain a line break or a tab: the server would read it as a second command`;
  }
  if (value.trim().length === 0) return `${param.name} is required`;
  if (param.type === "int" && !/^-?\d+$/.test(value)) {
    return `${param.name} must be a whole number, and "${value}" is not`;
  }
  if (param.type === "float" && !Number.isFinite(Number(value))) {
    return `${param.name} must be a number, and "${value}" is not`;
  }
  if (param.type === "bool" && !BOOLEANS.has(value.toLowerCase())) {
    return `${param.name} must be one of 0, 1, true or false, and "${value}" is not`;
  }
  if (param.type === "enum" && param.values !== undefined && !param.values.includes(value)) {
    return `${param.name} must be one of ${param.values.join(", ")}, and "${value}" is not`;
  }
  return null;
}

/**
 * Builds the line to send for a command and its named arguments.
 *
 * The caller never composes a command line: it names a command and supplies
 * arguments by parameter name, and everything about the resulting text is
 * decided here. That is what makes it impossible to send something the schema
 * does not describe - including `stop`, `exit` and `quit`, which are absent
 * from the schema entirely and so fail as unknown names rather than through a
 * special case that could be bypassed.
 *
 * No leading slash: the slash is chat syntax, and the console takes bare names,
 * which is the form `ProcessManager.stop` has always used.
 *
 * Throws with an operator-readable reason rather than returning a result, so a
 * caller cannot accidentally send an invalid line.
 */
export function composeCommand(name: string, args: Record<string, string>): string {
  const def = find(name);
  if (def === undefined) {
    throw new Error(`"${name}" is not a server command this daemon will send.`);
  }

  const known = new Set(def.params.map((p) => p.name));
  for (const supplied of Object.keys(args)) {
    if (!known.has(supplied)) {
      throw new Error(
        `"${name}" has no argument called "${supplied}". It takes: ${
          def.params.length === 0 ? "nothing" : def.params.map((p) => p.name).join(", ")
        }.`,
      );
    }
  }

  const parts: string[] = [name];
  for (const param of def.params) {
    const value = args[param.name];
    if (value === undefined || value === "") {
      if (!param.optional) throw new Error(`"${name}" needs ${param.name}.`);
      // Dropped rather than treated as a gap. A leading optional followed by a
      // required parameter is a real shape here (give, armorset): the game
      // resolves the remaining values by type, as it does for a player typing
      // the command in chat.
      continue;
    }
    const problem = reject(param, value);
    if (problem !== null) throw new Error(problem);
    parts.push(value);
  }
  return parts.join(" ");
}
