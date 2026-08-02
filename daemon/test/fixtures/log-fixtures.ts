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
