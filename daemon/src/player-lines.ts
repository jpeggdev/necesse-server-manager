import { normalize } from "./log-lines.js";

/**
 * Parsers for the console lines that carry connection facts.
 *
 * All of them run on `normalize`d input. ProcessManager strips ANSI before it
 * records a line, but not the `[YYYY-MM-DD HH:MM:SS] ` prefix, and every
 * pattern here is anchored at the start of the message.
 *
 * Formats read out of the game, not the wiki:
 * `Server.addClient`, `PacketDisconnect.processServer`, `ServerClient` and
 * `PlayersServerCommand`.
 */

/**
 * `Client "<auth>" with address <addr> is connecting with version <v>.`
 *
 * The only connect-side line that always carries the authentication. The
 * "connected on slot" line prints a display name instead once the world knows
 * the player, which is why the roster keys off this one.
 */
export function parsePlayerConnecting(line: string): { auth: string } | null {
  const m = /^Client "([^"]+)" with address .+ is connecting with version /.exec(normalize(line));
  return m ? { auth: m[1] } : null;
}

/** `Client "<consoleName>" connected on slot <n>/<slots>.` */
export function parsePlayerConnected(
  line: string,
): { consoleName: string; slot: number; slots: number } | null {
  const m = /^Client "([^"]*)" connected on slot (\d+)\/(\d+)\.$/.exec(normalize(line));
  return m ? { consoleName: m[1], slot: Number(m[2]), slots: Number(m[3]) } : null;
}

/**
 * `Player <auth> ("<name>") disconnected with message: <reason>`
 *
 * Anchored on `")` with no slot clause, so the two "tried to disconnect
 * wrong ..." lines from the same method cannot match: they report a rejected
 * request, not a departure.
 */
export function parsePlayerDisconnected(
  line: string,
): { auth: string; name: string; reason: string } | null {
  const m = /^Player (\d+) \("(.*)"\) disconnected with message: (.*)$/.exec(normalize(line));
  return m ? { auth: m[1], name: m[2], reason: m[3] } : null;
}

/**
 * The two departures that never produce a disconnect line, because they reach
 * `Server.disconnectClient` directly. Both carry only a quoted name, which is
 * why the roster may have to fall back on asking the server who is left.
 */
export function parsePlayerDropped(line: string): { name: string } | null {
  const n = normalize(line);
  const timeout = /^Resetting connection for "(.*)" due to no packets received for /.exec(n);
  if (timeout) return { name: timeout[1] };
  const ping = /^Ping threshold for "(.*)" reached, resulting in kick\./.exec(n);
  return ping ? { name: ping[1] } : null;
}

/**
 * `Loaded player: <auth>`
 *
 * Printed once the player is actually in the world, after the connect lines.
 * The roster treats this as confirmation of presence rather than as a join,
 * because a single act of joining can produce more than one connection: the
 * client connects to check mods, and connects again once a character has been
 * chosen. If the first connection's disconnect line arrives after the second
 * connection is up, a roster keyed by authentication would drop somebody who
 * is on. This line puts them back.
 */
export function parsePlayerLoaded(line: string): { auth: string } | null {
  const m = /^Loaded player: (\d+)$/.exec(normalize(line));
  return m ? { auth: m[1] } : null;
}

/** `Players online: <online>/<slots>` */
export function parsePlayersHeader(line: string): { online: number; slots: number } | null {
  const m = /^Players online: (\d+)\/(\d+)$/.exec(normalize(line));
  return m ? { online: Number(m[1]), slots: Number(m[2]) } : null;
}

/**
 * `Slot <n>: <auth> "<name>", latency: <ms>, level: <identifier>,conn: <addr>`
 *
 * Name and level are both taken greedily, against their own closing delimiter
 * rather than the first comma: a name can contain one ("Bob, the Builder") and
 * an island level identifier routinely does ("island 12, 8 cave"). The game
 * emits no space after the comma before `conn:`, which is what makes that a
 * usable anchor.
 */
export function parsePlayersRow(
  line: string,
): { slot: number; auth: string; name: string; latency: number; level: string } | null {
  const m = /^Slot (\d+): (\d+) "(.*)", latency: (-?\d+), level: (.*),conn: .*$/.exec(normalize(line));
  return m ? { slot: Number(m[1]), auth: m[2], name: m[3], latency: Number(m[4]), level: m[5] } : null;
}
