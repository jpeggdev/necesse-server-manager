/**
 * Where this app remembers which daemon to talk to.
 *
 * localStorage rather than a file behind a Tauri command: a command would be a
 * new client-to-Rust boundary that the test suite could only mock, and a mocked
 * boundary is exactly the shape that once let five actions ship broken with the
 * suite green. Portability - moving to a second workstation - is served by the
 * copy/paste blob in the settings screen instead.
 */
export interface Connection {
  host: string;
  port: number;
  /** Empty when the daemon runs with no access token, which is a supported mode. */
  token: string;
}

export const CONNECTION_KEY = "necesse.connection";

const parse = (text: string | null): Connection | null => {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Corrupt storage reads as unconfigured. Throwing here would white-screen
    // the app at startup with no route to the settings form that fixes it.
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { host, port, token } = raw as Record<string, unknown>;
  if (typeof host !== "string" || host.trim().length === 0) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof token !== "string") return null;
  return { host, port, token };
};

export const loadConnection = (): Connection | null => parse(localStorage.getItem(CONNECTION_KEY));

export const saveConnection = (c: Connection): void => {
  localStorage.setItem(CONNECTION_KEY, JSON.stringify(c));
};

export const clearConnection = (): void => {
  localStorage.removeItem(CONNECTION_KEY);
};

export const baseUrl = (c: Connection): string => `http://${c.host}:${c.port}`;

/**
 * A browser cannot set an Authorization header on a WebSocket handshake, so the
 * token rides the query string. The daemon reads both channels through one
 * check.
 */
export const wsUrl = (c: Connection): string =>
  `ws://${c.host}:${c.port}/ws` +
  (c.token.length > 0 ? `?token=${encodeURIComponent(c.token)}` : "");

export const encodeConnection = (c: Connection): string => JSON.stringify(c, null, 2);

export const decodeConnection = (text: string): Connection | null => parse(text.trim());
