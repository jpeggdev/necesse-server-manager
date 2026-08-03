export interface ReadyInfo {
  port: number;
  slots: number;
  world: string;
  gameVersion: string;
}

const TIMESTAMP = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/;

/**
 * SGR colour escapes. Live capture on 2026-07-27 (docs/verification-2026-07-27.md)
 * showed the real server emits one at the START of every stdout line, BEFORE
 * the timestamp - ESC[39m for a normal line, ESC[34m for (DEBUG), ESC[33m for
 * (WARN). That is neither of the two forms the parsers were written to
 * tolerate, and it defeats any anchored match: TIMESTAMP stopped matching, so
 * isStopped's equality test silently never fired against the real server.
 * Stripped before the timestamp for that reason.
 *
 * Built with String.fromCharCode rather than written as a regex literal: an
 * ESC inside a literal is either a raw control byte - invisible in every
 * editor and diff, and unmatchable by a later search-and-replace - or an
 * escape sequence that tooling in the path has a habit of eating. This form is
 * plain ASCII end to end.
 */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

const READY =
  /Started server using port (\d+) with (\d+) slots on world "(.+?)", game version (\d+(?:\.\d+)*)/;

export function stripAnsi(line: string): string {
  return line.replace(ANSI, "");
}

export function stripTimestamp(line: string): string {
  return line.replace(TIMESTAMP, "");
}

/**
 * The one normalisation every parser goes through. Decoration is not something
 * to match on: stdout colours its lines, the log file does not, and an
 * untimestamped form was plausible until it was measured. Parsers match the
 * message text with all of it removed rather than any one observed shape.
 */
export function normalize(line: string): string {
  return stripTimestamp(stripAnsi(line));
}

export function parseReady(line: string): ReadyInfo | null {
  const m = READY.exec(normalize(line));
  if (!m) return null;
  const world = m[3].endsWith(".zip") ? m[3].slice(0, -".zip".length) : m[3];
  return {
    port: Number(m[1]),
    slots: Number(m[2]),
    world,
    gameVersion: m[4],
  };
}

export function isStopped(line: string): boolean {
  return normalize(line) === "Server has stopped";
}

/**
 * The game's "Type help for list of commands." line, which marks the first
 * moment a command sent to it is acted on rather than echoed and discarded.
 *
 * The command scanner reads stdin from launch, but `ServerLoader.handleCommand`
 * drops everything while its `server` field is null, and that field is assigned
 * only once `startServer` RETURNS. This is the last line `startServer` prints
 * before returning, so it is the closest observable to that assignment - closer
 * than the ready line, which the game prints from three statements earlier and
 * which is therefore still too early to send anything on.
 */
export function isCommandsHint(line: string): boolean {
  return normalize(line) === "Type help for list of commands.";
}
