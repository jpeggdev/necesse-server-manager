import { describe, it, expect } from "vitest";
import { AUTH_FAILURE_MESSAGE, presentedToken, tokenMatches } from "../src/auth.js";

describe("tokenMatches", () => {
  it("accepts anything when no token is configured, which is the opt-out", () => {
    expect(tokenMatches("", undefined)).toBe(true);
    expect(tokenMatches("", "whatever")).toBe(true);
  });

  it("accepts the exact token", () => {
    expect(tokenMatches("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong token, an absent one, and a prefix of the right one", () => {
    expect(tokenMatches("s3cret", "wrong")).toBe(false);
    expect(tokenMatches("s3cret", undefined)).toBe(false);
    expect(tokenMatches("s3cret", "s3cre")).toBe(false);
    expect(tokenMatches("s3cret", "")).toBe(false);
  });

  // A configured token that is only whitespace is treated the same as an unset
  // one, matching how steamApiKeyConfigured already reads steamApiKey - see
  // publicConfig in http.ts. Without this, a config.json with `"authToken": " "`
  // would silently demand a token no sane client would ever send.
  it("treats a whitespace-only configured token as unset, the same opt-out as empty", () => {
    expect(tokenMatches("   ", undefined)).toBe(true);
    expect(tokenMatches("   ", "whatever")).toBe(true);
  });
});

describe("presentedToken", () => {
  it("reads a bearer header, case-insensitively on the scheme", () => {
    expect(presentedToken({ headers: { authorization: "Bearer abc" }, query: {} })).toBe("abc");
    expect(presentedToken({ headers: { authorization: "bearer abc" }, query: {} })).toBe("abc");
  });

  it("reads the query parameter, which is all a WebSocket handshake can carry", () => {
    expect(presentedToken({ headers: {}, query: { token: "abc" } })).toBe("abc");
  });

  it("prefers the header when both are present", () => {
    expect(presentedToken({ headers: { authorization: "Bearer hdr" }, query: { token: "qs" } })).toBe(
      "hdr",
    );
  });

  it("is undefined for a missing or malformed header", () => {
    expect(presentedToken({ headers: {}, query: {} })).toBeUndefined();
    expect(presentedToken({ headers: { authorization: "Basic abc" }, query: {} })).toBeUndefined();
    expect(presentedToken({ headers: { authorization: "Bearer" }, query: {} })).toBeUndefined();
  });

  // The header value is already trimmed (`rest.join(" ").trim()` above); the
  // query value must accept the same pasted-with-a-trailing-space token, or a
  // WebSocket client - which has no header to fall back to - is stricter than
  // an HTTP client for the exact same configured secret.
  it("trims the query token the same way the header value is trimmed", () => {
    expect(presentedToken({ headers: {}, query: { token: " abc " } })).toBe("abc");
    expect(presentedToken({ headers: { authorization: "Bearer  abc " }, query: {} })).toBe("abc");
  });
});

describe("AUTH_FAILURE_MESSAGE", () => {
  // /token/i on a constant containing the word "token" could not fail whatever
  // the message said. These are the three things a rejected client actually
  // needs and cannot work out for itself: both ways to present the token, and
  // where to find it. Rewording the message is fine; dropping any of them is
  // what this is here to catch.
  it("names both ways to present a token and where to find it", () => {
    expect(AUTH_FAILURE_MESSAGE).toContain("Authorization: Bearer");
    expect(AUTH_FAILURE_MESSAGE).toContain("?token=");
    expect(AUTH_FAILURE_MESSAGE).toContain("config.json");
  });
});
