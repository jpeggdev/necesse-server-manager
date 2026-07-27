import { describe, it, expect } from "vitest";
import { stripTimestamp, parseReady, isStopped, isLoadingExistingWorld } from "../src/log-lines.js";
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
