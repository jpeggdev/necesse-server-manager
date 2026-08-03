import { describe, it, expect } from "vitest";
import {
  stripTimestamp,
  stripAnsi,
  normalize,
  parseReady,
  isStopped,
  isCommandsHint,
} from "../src/log-lines.js";
import * as F from "./fixtures/log-fixtures.js";

describe("stripTimestamp", () => {
  it("removes a leading bracketed timestamp", () => {
    expect(stripTimestamp(F.STOPPED_LINE)).toBe("Server has stopped");
  });
  it("leaves an untimestamped line alone", () => {
    expect(stripTimestamp(F.READY_LINE_NO_TS)).toBe(F.READY_LINE_NO_TS);
  });
});

describe("parseReady", () => {
  it("parses the ready line with a timestamp", () => {
    expect(parseReady(F.READY_LINE_WITH_TS)).toEqual({
      port: 14159,
      slots: 5,
      world: "Infected Toenail",
      gameVersion: "1.2.0",
    });
  });

  it("parses the ready line without a timestamp", () => {
    expect(parseReady(F.READY_LINE_NO_TS)?.world).toBe("Infected Toenail");
  });

  it("strips only a trailing .zip, preserving names containing dots", () => {
    const line = 'Started server using port 1 with 2 slots on world "v1.2 test.zip", game version 1.2.0.';
    expect(parseReady(line)?.world).toBe("v1.2 test");
  });

  it("returns null for unrelated lines", () => {
    expect(parseReady(F.MOD_FOUND)).toBeNull();
    expect(parseReady(F.INVALID_JAR_WARN)).toBeNull();
  });
});

describe("isStopped", () => {
  it("matches the shutdown line", () => {
    expect(isStopped(F.STOPPED_LINE)).toBe(true);
  });
  it("does not match the save line or the stop echo", () => {
    expect(isStopped(F.SAVE_COMPLETE)).toBe(false);
    expect(isStopped(F.STOP_ECHO)).toBe(false);
  });
});

describe("isCommandsHint", () => {
  it("matches the line the game prints once its commands take effect", () => {
    expect(isCommandsHint(F.REAL_COMMANDS_HINT)).toBe(true);
  });

  /*
   * The ready line is the one that matters here. The game prints it from
   * inside `startServer`, three statements before the return that makes
   * commands take effect, so treating it as the hint is exactly the mistake
   * this parser exists to avoid - and one the daemon's own startup `players`
   * probe was observed making live on 2026-08-03.
   */
  it("does not match the ready line or anything else in the startup burst", () => {
    expect(isCommandsHint(F.REAL_READY)).toBe(false);
    expect(isCommandsHint(F.READY_LINE_WITH_TS)).toBe(false);
    expect(isCommandsHint(F.STOPPED_LINE)).toBe(false);
    expect(isCommandsHint(F.MOD_FOUND)).toBe(false);
  });

  /*
   * The captured fixture came through the daemon's console stream, which had
   * already stripped the escape, so this rebuilds the raw stdout form. Built
   * with fromCharCode rather than written as a literal for the reason
   * log-lines.ts gives: an ESC in a literal is either an invisible control
   * byte or an escape the tooling in the path eats before it reaches disk.
   */
  it("matches through the colour escape stdout puts before the timestamp", () => {
    const esc = String.fromCharCode(27);
    expect(isCommandsHint(`${esc}[39m${F.REAL_COMMANDS_HINT}`)).toBe(true);
  });
});

/*
 * Regression cover for the one thing the unit tests could not know before the
 * server was run for real: stdout prefixes an SGR colour escape BEFORE the
 * timestamp.
 *
 * Only one case here actually fails against the pre-2026-07-27 parsers -
 * "recognises the shutdown line", measured by reverting isStopped to
 * stripTimestamp and re-running. The rest are regression guards, not bug
 * reproductions:
 * `parseReady` passed all along because READY is an unanchored substring
 * search, the normalize/stripAnsi cases exercise API that did not exist
 * pre-fix, and the last case pins behaviour that was already correct. Said
 * explicitly because "these tests cover the bug" is easy to assume of a whole
 * block and wrong here.
 */
describe("the real stdout format (colour escape before the timestamp)", () => {
  it("strips the escape and the timestamp together", () => {
    expect(normalize(F.REAL_STOPPED)).toBe("Server has stopped");
    expect(normalize(F.REAL_SAVE_COMPLETE)).toBe("Completed world save before stopping server");
    expect(normalize(F.REAL_DEBUG)).toBe("(DEBUG) Initializing DesktopPlatform");
  });

  it("recognises the shutdown line", () => {
    expect(isStopped(F.REAL_STOPPED)).toBe(true);
    expect(isStopped(F.REAL_SAVE_COMPLETE)).toBe(false);
    expect(isStopped(F.REAL_STOP_ECHO)).toBe(false);
  });

  it("parses the ready line", () => {
    expect(parseReady(F.REAL_READY)).toEqual({
      port: 14159,
      slots: 5,
      world: "Tulsa",
      gameVersion: "1.2.0",
    });
  });

  it("handles every colour the server uses, and leaves an uncoloured line alone", () => {
    expect(stripAnsi(F.REAL_WARN)).toBe(F.INVALID_JAR_WARN.replace("2026-07-26 22:40:42", "2026-07-27 03:27:28"));
    expect(stripAnsi(F.STOPPED_LINE)).toBe(F.STOPPED_LINE);
    // stripTimestamp alone is still exactly what its name says: it does not
    // reach past a leading escape. normalize() is the composed one.
    expect(stripTimestamp(F.REAL_STOPPED)).toBe(F.REAL_STOPPED);
  });
});
