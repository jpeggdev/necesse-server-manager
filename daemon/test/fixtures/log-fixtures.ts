export const READY_LINE_WITH_TS =
  '[2026-07-26 22:40:55] Started server using port 14159 with 5 slots on world "Infected Toenail.zip", game version 1.2.0.';

export const READY_LINE_NO_TS =
  'Started server using port 14159 with 5 slots on world "Infected Toenail.zip", game version 1.2.0.';

export const STOP_ECHO = "[2026-07-26 23:18:22] > stop";
export const SAVE_COMPLETE = "[2026-07-26 23:18:22] Completed world save before stopping server";
export const STOPPED_LINE = "[2026-07-26 23:18:22] Server has stopped";
export const MOD_FOUND =
  "[2026-07-26 22:40:42] Found mod: Safe Haven QOL (torvian.qol, 2.6) from ModsFolderModProvider";
export const INVALID_JAR_WARN =
  "[2026-07-26 22:40:42] (WARN) Invalid mod jar located at C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\mods\\torvians-qol.cfg";

/*
 * The real thing. Captured off the live server's stdout on 2026-07-27 (see
 * docs/verification-2026-07-27.md): every line is prefixed with an SGR colour
 * escape BEFORE the timestamp - \e[39m for normal, \e[34m for (DEBUG),
 * \e[33m for (WARN) - which is neither of the two forms the parsers were
 * originally written to tolerate. The escapes are written as \u001b rather
 * than pasted as literal control bytes so these lines stay greppable and
 * editable.
 */
export const REAL_READY = `\u001b[39m[2026-07-27 03:27:40] Started server using port 14159 with 5 slots on world "Tulsa.zip", game version 1.2.0.`;
export const REAL_STOPPED = "\u001b[39m[2026-07-27 03:29:27] Server has stopped";
export const REAL_SAVE_COMPLETE =
  "\u001b[39m[2026-07-27 03:29:27] Completed world save before stopping server";
export const REAL_STOP_ECHO = "\u001b[39m[2026-07-27 03:29:27] > stop";
export const REAL_DEBUG =
  "\u001b[34m[2026-07-27 03:27:26] (DEBUG) Initializing DesktopPlatform";
export const REAL_WARN =
  "\u001b[33m[2026-07-27 03:27:28] (WARN) Invalid mod jar located at C:\\Users\\jeffp\\AppData\\Roaming\\Necesse\\mods\\torvians-qol.cfg";

/*
 * The last line the game prints before `startServer` returns and
 * `ServerLoader.server` stops being null - which is what makes it the earliest
 * point a stop command is acted on rather than echoed and discarded.
 *
 * Captured on 2026-08-03 off the live server (v1.3.1) through the daemon's own
 * console stream, which is why this one carries no colour escape: `ingest`
 * strips it before recording. The surrounding lines in that capture were, in
 * order: the ready line, "Found 1 saved players.", a `> players` that was
 * echoed and then silently ignored, "Local address: 192.168.1.106:14159", and
 * this. That ignored `players` is the daemon's own startup probe, and it is the
 * live evidence that the ready line is too early to send anything on.
 */
export const REAL_COMMANDS_HINT = "[2026-08-03 13:19:12] Type help for list of commands.";

/*
 * A real join and a real quit, captured from the live server's
 * latest-server-log.txt on 2026-08-01, game version 1.3.1. The player joined
 * at 21:23:18 and quit fifteen seconds later.
 *
 * Evidence, not illustration: these are the exact formats
 * Server.addClient and PacketDisconnect.processServer produce, and the auth on
 * the connect line is what the roster keys off. Do not tidy the address, the
 * quoting or the punctuation.
 *
 * Note what is NOT here. A normal quit is the ONLY departure that prints the
 * "disconnected with message" line - timeouts, latency kicks, /kick and
 * shutdown all reach Server.disconnectClient, which prints nothing per player.
 * That absence is why the roster reconciles against /players rather than
 * trusting a connect/disconnect pairing.
 *
 * These come from the log file rather than stdout, so they carry no SGR colour
 * escape. The live stdout does (see REAL_READY above), which is why the
 * parsers normalize rather than matching a bare timestamp.
 */
export const REAL_CONNECTING =
  '[2026-08-01 21:23:18] Client "76561198048435182" with address 192.168.1.64:64832 is connecting with version 1.3.1.';
export const REAL_CONNECTED = '[2026-08-01 21:23:18] Client "Jeff" connected on slot 1/5.';
export const REAL_DISCONNECTED =
  '[2026-08-01 21:23:33] Player 76561198048435182 ("Jeff") disconnected with message: Quit';

/*
 * A real /players answer, captured 2026-08-02 04:08:50 from the live 1.3.1
 * server with nobody connected.
 *
 * The echo line matters as much as the answer. Sent moments earlier, at the
 * instant the ready line appeared, the identical command produced the echo and
 * NOTHING else: the world was still initialising, so it parsed and silently did
 * nothing. That is why the daemon asks again until the server answers, rather
 * than assuming a sent command ran.
 */
export const REAL_PLAYERS_ECHO = "[2026-08-02 04:08:50] > players";
export const REAL_PLAYERS_EMPTY = "[2026-08-02 04:08:50] Players online: 0/5";

/*
 * A real /players answer with somebody on it, captured 2026-08-02 04:11:52,
 * and the line the game prints once that player is actually in the world.
 *
 * `latency: 0` is not a placeholder - that is what the server reported for a
 * client on the same LAN, and it is why the roster treats 0 as a value rather
 * than as "unknown".
 */
export const REAL_PLAYERS_ONE = "[2026-08-02 04:11:52] Players online: 1/5";
export const REAL_PLAYERS_ROW =
  '[2026-08-02 04:11:52] Slot 1: 76561198048435182 "Jeff", latency: 0, level: surface,conn: 192.168.1.64:51802';
export const REAL_PLAYER_LOADED = "[2026-08-02 04:11:01] Loaded player: 76561198048435182";
