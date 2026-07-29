import { describe, it, expect, beforeEach } from "vitest";
import {
  CONNECTION_KEY,
  baseUrl,
  clearConnection,
  decodeConnection,
  encodeConnection,
  loadConnection,
  saveConnection,
  wsUrl,
} from "../src/settings";

beforeEach(() => {
  localStorage.clear();
});

describe("loadConnection", () => {
  it("is null before anything is saved", () => {
    expect(loadConnection()).toBeNull();
  });

  it("round-trips a saved connection", () => {
    saveConnection({ host: "192.168.1.106", port: 8710, token: "abc" });
    expect(loadConnection()).toEqual({ host: "192.168.1.106", port: 8710, token: "abc" });
  });

  it("treats corrupt stored data as unconfigured rather than throwing", () => {
    localStorage.setItem(CONNECTION_KEY, "not json");
    expect(loadConnection()).toBeNull();
  });

  it("treats a partial record as unconfigured", () => {
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({ host: "h" }));
    expect(loadConnection()).toBeNull();
  });

  it("rejects a stored port that is not a usable number", () => {
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({ host: "h", port: "eight", token: "" }));
    expect(loadConnection()).toBeNull();
  });

  it("accepts an empty token, which is the daemon's no-auth mode", () => {
    saveConnection({ host: "h", port: 1, token: "" });
    expect(loadConnection()).toEqual({ host: "h", port: 1, token: "" });
  });
});

describe("clearConnection", () => {
  it("removes what was saved", () => {
    saveConnection({ host: "h", port: 1, token: "" });
    clearConnection();
    expect(loadConnection()).toBeNull();
  });
});

describe("urls", () => {
  it("builds the http base", () => {
    expect(baseUrl({ host: "h", port: 8710, token: "" })).toBe("http://h:8710");
  });

  it("omits the token from the socket url when there is none", () => {
    expect(wsUrl({ host: "h", port: 8710, token: "" })).toBe("ws://h:8710/ws");
  });

  it("carries the token on the socket url, which is all a handshake can do", () => {
    expect(wsUrl({ host: "h", port: 8710, token: "a b" })).toBe("ws://h:8710/ws?token=a%20b");
  });
});

describe("encode/decode", () => {
  it("round-trips through the clipboard blob", () => {
    const c = { host: "192.168.1.106", port: 8710, token: "abc" };
    expect(decodeConnection(encodeConnection(c))).toEqual(c);
  });

  it("is null for text that is not a connection", () => {
    expect(decodeConnection("hello")).toBeNull();
    expect(decodeConnection(JSON.stringify({ host: "h" }))).toBeNull();
  });
});
