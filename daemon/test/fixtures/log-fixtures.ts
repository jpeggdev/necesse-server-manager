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
