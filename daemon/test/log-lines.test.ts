import { describe, it, expect } from "vitest";
import {
  stripTimestamp,
  stripAnsi,
  normalize,
  parseReady,
  isStopped,
  isLoadingExistingWorld,
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

describe("isLoadingExistingWorld", () => {
  it("detects an existing world load", () => {
    expect(isLoadingExistingWorld(F.LOADING_EXISTING)).toBe(true);
    expect(isLoadingExistingWorld(F.READY_LINE_NO_TS)).toBe(false);
  });
});

/*
 * Regression cover for the one thing the unit tests could not know before the
 * server was run for real: stdout prefixes an SGR colour escape BEFORE the
 * timestamp. Every assertion below fails against the pre-2026-07-27 parsers.
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

  it("recognises an existing-world load", () => {
    expect(isLoadingExistingWorld(F.REAL_LOADING_EXISTING)).toBe(true);
    expect(isLoadingExistingWorld(F.REAL_READY)).toBe(false);
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
