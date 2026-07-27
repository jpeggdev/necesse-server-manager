export interface ReadyInfo {
  port: number;
  slots: number;
  world: string;
  gameVersion: string;
}

const TIMESTAMP = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/;

const READY =
  /Started server using port (\d+) with (\d+) slots on world "(.+?)", game version (\d+(?:\.\d+)*)/;

/**
 * The log file prefixes every line with a timestamp; whether stdout does is
 * unverified. Every parser tolerates both forms rather than assuming one.
 */
export function stripTimestamp(line: string): string {
  return line.replace(TIMESTAMP, "");
}

export function parseReady(line: string): ReadyInfo | null {
  const m = READY.exec(stripTimestamp(line));
  if (!m) return null;
  const world = m[3].endsWith(".zip") ? m[3].slice(0, -".zip".length) : m[3];
  return {
    port: Number(m[1]),
    slots: Number(m[2]),
    world,
    gameVersion: m[4],
  };
}

export function isStopped(line: string): boolean {
  return stripTimestamp(line) === "Server has stopped";
}

export function isLoadingExistingWorld(line: string): boolean {
  return stripTimestamp(line).startsWith("Loading existing world at ");
}
