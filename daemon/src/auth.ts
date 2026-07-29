import { createHash, timingSafeEqual } from "node:crypto";

export const AUTH_FAILURE_MESSAGE =
  "This daemon requires an access token. Send it as an Authorization: Bearer header, or as " +
  "?token= on the websocket URL. The token is in config.json on the server, under authToken.";

/**
 * Compared as SHA-256 digests rather than raw buffers so the comparison is
 * both constant-time and length-independent: timingSafeEqual throws on
 * mismatched lengths, and branching on length to avoid that would leak the
 * length of the real token.
 */
export function tokenMatches(configured: string, presented: string | undefined): boolean {
  // Trimmed before the opt-out check, matching how publicConfig's
  // steamApiKeyConfigured already reads steamApiKey: a whitespace-only value is
  // not a secret anyone could send back, so treating it as "set" would demand a
  // token no client can produce, with no visible reason why every request 401s.
  const wanted = configured.trim();
  // Empty (or whitespace-only) configured token disables the check. This is
  // the documented trusted-LAN opt-out, and it is what lets a config.json
  // written before this feature keep working across an upgrade.
  if (wanted.length === 0) return true;
  if (presented === undefined || presented.length === 0) return false;
  const a = createHash("sha256").update(wanted).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

/**
 * The token this request carries, from whichever channel could carry one.
 *
 * A browser cannot set headers on a WebSocket handshake, so the socket route
 * has to accept a query parameter. Both are read here so there is exactly one
 * answer to "what did this request present" and no second path to forget.
 */
export function presentedToken(req: {
  headers: Record<string, unknown>;
  query: unknown;
}): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const [scheme, ...rest] = header.split(" ");
    const value = rest.join(" ").trim();
    if (scheme.toLowerCase() === "bearer" && value.length > 0) return value;
  }
  const q = req.query;
  if (typeof q === "object" && q !== null) {
    const token = (q as { token?: unknown }).token;
    if (typeof token === "string" && token.length > 0) return token;
  }
  return undefined;
}
