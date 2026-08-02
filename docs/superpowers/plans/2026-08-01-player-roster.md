# Player Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show who is on the server right now, in a Players tab beside Mods, derived from the console output the daemon already streams and reconciled against the server's own `/players` command.

**Architecture:** A pure parser module reads the six console lines that carry connection facts. A stateful roster keyed by the player's Steam authentication consumes those parses, and is replaced wholesale by a parsed `/players` block. The roster subscribes to `ProcessManager`'s existing `"line"` event, so no new plumbing is added to the process layer, and it broadcasts its own `players` WebSocket message rather than riding on `StatusPayload`.

**Tech Stack:** Node 22 + TypeScript + Fastify + vitest (daemon); React 19 + Vite + vitest + React Testing Library (client).

This is phase 1 of the design in `docs/superpowers/specs/2026-08-01-player-tracking-and-commands-design.html`. Phase 2 (generated forms for the game's 90 server commands) is a separate plan and depends on this one only for the online-player dropdown.

## Global Constraints

- **Daemon sources must stay ES2020-library-compatible.** `client/test/api.integration.test.ts` imports the real daemon, so every daemon file is typechecked a second time under the client's ES2020 lib. No `Object.hasOwn`, `Array.prototype.at`, `findLast`, or `String.prototype.replaceAll`.
- **`daemon/src/types.ts` and `client/src/types.ts` must stay byte-identical.** Hash both after editing either: `git hash-object daemon/src/types.ts client/src/types.ts`.
- **Errors are never swallowed or reworded.** A `catch` that returns a default is a defect here.
- **ANSI is already stripped** by `ProcessManager.ingest` before `record`/`inspect`, but the `[YYYY-MM-DD HH:MM:SS] ` timestamp prefix is NOT. Every parser must run on `normalize(line)` from `log-lines.ts`, and every parser test must feed lines WITH the timestamp prefix, because that is how they really arrive.
- **The roster is keyed by authentication, never by name.** `Client <consoleName> connected on slot n/m` prints the numeric auth instead of a name for a first-time player.
- Verify from inside `daemon/` or `client/`: `npx vitest run` and `npx tsc --noEmit`. Run the two packages separately; there is no workspace root.
- Plain ASCII punctuation in all user-facing copy. No em dashes, no curly quotes.

---

### Task 1: The line parsers

**Files:**
- Create: `daemon/src/player-lines.ts`
- Create: `daemon/test/player-lines.test.ts`

**Interfaces:**
- Consumes: `normalize` from `daemon/src/log-lines.ts`.
- Produces:
  - `parsePlayerConnecting(line: string): { auth: string } | null`
  - `parsePlayerConnected(line: string): { consoleName: string; slot: number; slots: number } | null`
  - `parsePlayerDisconnected(line: string): { auth: string; name: string; reason: string } | null`
  - `parsePlayerDropped(line: string): { name: string } | null`
  - `parsePlayersHeader(line: string): { online: number; slots: number } | null`
  - `parsePlayersRow(line: string): { slot: number; auth: string; name: string; latency: number; level: string } | null`

- [ ] **Step 1: Write the failing tests**

Create `daemon/test/player-lines.test.ts`. Every input carries the real timestamp prefix.

```typescript
import { describe, it, expect } from "vitest";
import {
  parsePlayerConnecting,
  parsePlayerConnected,
  parsePlayerDisconnected,
  parsePlayerDropped,
  parsePlayersHeader,
  parsePlayersRow,
} from "../src/player-lines.js";

const TS = "[2026-08-01 21:31:04] ";

describe("parsePlayerConnecting", () => {
  it("takes the auth off the only line that always carries it", () => {
    const r = parsePlayerConnecting(
      `${TS}Client "76561198048435182" with address 192.168.1.50:52134 is connecting with version 1.3.1.`,
    );
    expect(r).toEqual({ auth: "76561198048435182" });
  });

  it("reads a LOCAL address the same way", () => {
    const r = parsePlayerConnecting(`${TS}Client "76561198048435182" with address LOCAL is connecting with version 1.3.1.`);
    expect(r?.auth).toBe("76561198048435182");
  });

  it("is null for an unrelated line", () => {
    expect(parsePlayerConnecting(`${TS}Started server using port 14159 with 5 slots.`)).toBeNull();
  });
});

describe("parsePlayerConnected", () => {
  it("reads the slot and the console name for a returning player", () => {
    expect(parsePlayerConnected(`${TS}Client "Jeff" connected on slot 1/5.`)).toEqual({
      consoleName: "Jeff",
      slot: 1,
      slots: 5,
    });
  });

  // Server.addClient prints the auth here when the world has never seen this
  // player. Treating that as a display name would put a Steam id in the UI.
  it("reads the auth as the console name for a first-time player", () => {
    expect(parsePlayerConnected(`${TS}Client "76561198048435182" connected on slot 3/5.`)).toEqual({
      consoleName: "76561198048435182",
      slot: 3,
      slots: 5,
    });
  });
});

describe("parsePlayerDisconnected", () => {
  it("reads auth, name and reason", () => {
    expect(
      parsePlayerDisconnected(`${TS}Player 76561198048435182 ("Jeff") disconnected with message: Quit`),
    ).toEqual({ auth: "76561198048435182", name: "Jeff", reason: "Quit" });
  });

  it("keeps a multi-word reason whole", () => {
    const r = parsePlayerDisconnected(
      `${TS}Player 76561198048435182 ("Jeff") disconnected with message: Connection timed out`,
    );
    expect(r?.reason).toBe("Connection timed out");
  });

  // The near-miss lines from the same method, which must NOT close an entry.
  it("ignores the wrong-slot and wrong-code variants", () => {
    expect(
      parsePlayerDisconnected(`${TS}Player 7656 ("Jeff", slot 1) tried to disconnect wrong client slot: 2`),
    ).toBeNull();
    expect(
      parsePlayerDisconnected(`${TS}Player 7656 ("Jeff", slot 1) tried to disconnect wrong code: BANNED_CLIENT`),
    ).toBeNull();
  });
});

describe("parsePlayerDropped", () => {
  it("reads the name out of a timeout", () => {
    expect(
      parsePlayerDropped(`${TS}Resetting connection for "Jeff" due to no packets received for 30000 ms.`),
    ).toEqual({ name: "Jeff" });
  });

  it("reads the name out of a latency kick", () => {
    expect(
      parsePlayerDropped(`${TS}Ping threshold for "Jeff" reached, resulting in kick. Limit is 60 seconds.`),
    ).toEqual({ name: "Jeff" });
  });
});

describe("/players output", () => {
  it("reads the header", () => {
    expect(parsePlayersHeader(`${TS}Players online: 2/5`)).toEqual({ online: 2, slots: 5 });
  });

  it("reads a row, including the level that has no space after its comma", () => {
    expect(
      parsePlayersRow(`${TS}Slot 1: 76561198048435182 "Jeff", latency: 42, level: surface,conn: 192.168.1.50:52134`),
    ).toEqual({ slot: 1, auth: "76561198048435182", name: "Jeff", latency: 42, level: "surface" });
  });

  it("reads a row whose level identifier contains commas and spaces", () => {
    const r = parsePlayersRow(
      `${TS}Slot 2: 7656119800 "eli", latency: 31, level: island 12, 8 cave,conn: LOCAL`,
    );
    expect(r?.level).toBe("island 12, 8 cave");
    expect(r?.name).toBe("eli");
  });

  it("reads a name containing a quote-free comma", () => {
    const r = parsePlayersRow(`${TS}Slot 3: 7656119801 "Bob, the Builder", latency: 5, level: surface,conn: LOCAL`);
    expect(r?.name).toBe("Bob, the Builder");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

From `daemon/`: `npx vitest run test/player-lines.test.ts`
Expected: FAIL, cannot resolve `../src/player-lines.js`.

- [ ] **Step 3: Implement the parsers**

Create `daemon/src/player-lines.ts`:

```typescript
import { normalize } from "./log-lines.js";

/**
 * Parsers for the console lines that carry connection facts.
 *
 * All six run on `normalize`d input: ProcessManager strips ANSI before it
 * records a line, but not the timestamp prefix, and every one of these
 * patterns is anchored at the start of the line.
 *
 * Formats are from necesse.engine.network.server.Server.addClient,
 * necesse.engine.network.packet.PacketDisconnect.processServer,
 * necesse.engine.network.server.ServerClient and
 * necesse.engine.commands.serverCommands.PlayersServerCommand.
 */

/**
 * `Client "<auth>" with address <addr> is connecting with version <v>.`
 *
 * The only connect-side line that always carries the authentication - the
 * "connected on slot" line prints a display name instead once the world knows
 * the player.
 */
export function parsePlayerConnecting(line: string): { auth: string } | null {
  const m = /^Client "([^"]+)" with address .+ is connecting with version /.exec(normalize(line));
  return m ? { auth: m[1] } : null;
}

/** `Client "<consoleName>" connected on slot <n>/<slots>.` */
export function parsePlayerConnected(
  line: string,
): { consoleName: string; slot: number; slots: number } | null {
  const m = /^Client "([^"]*)" connected on slot (\d+)\/(\d+)\.$/.exec(normalize(line));
  return m ? { consoleName: m[1], slot: Number(m[2]), slots: Number(m[3]) } : null;
}

/**
 * `Player <auth> ("<name>") disconnected with message: <reason>`
 *
 * Anchored on `")` with no slot clause, so the two "tried to disconnect wrong
 * ..." lines from the same method - which report a rejected request, not a
 * departure - cannot match.
 */
export function parsePlayerDisconnected(
  line: string,
): { auth: string; name: string; reason: string } | null {
  const m = /^Player (\d+) \("(.*)"\) disconnected with message: (.*)$/.exec(normalize(line));
  return m ? { auth: m[1], name: m[2], reason: m[3] } : null;
}

/**
 * The two departures that never produce a disconnect line, because they reach
 * Server.disconnectClient directly. Both carry only a quoted name.
 */
export function parsePlayerDropped(line: string): { name: string } | null {
  const n = normalize(line);
  const timeout = /^Resetting connection for "(.*)" due to no packets received for /.exec(n);
  if (timeout) return { name: timeout[1] };
  const ping = /^Ping threshold for "(.*)" reached, resulting in kick\./.exec(n);
  return ping ? { name: ping[1] } : null;
}

/** `Players online: <online>/<slots>` */
export function parsePlayersHeader(line: string): { online: number; slots: number } | null {
  const m = /^Players online: (\d+)\/(\d+)$/.exec(normalize(line));
  return m ? { online: Number(m[1]), slots: Number(m[2]) } : null;
}

/**
 * `Slot <n>: <auth> "<name>", latency: <ms>, level: <identifier>,conn: <addr>`
 *
 * The level identifier is taken greedily up to the final `,conn:` because it
 * can contain commas and spaces (an island coordinate reads `island 12, 8
 * cave`), and the game emits no space after that comma.
 */
export function parsePlayersRow(
  line: string,
): { slot: number; auth: string; name: string; latency: number; level: string } | null {
  const m = /^Slot (\d+): (\d+) "(.*)", latency: (-?\d+), level: (.*),conn: .*$/.exec(normalize(line));
  return m
    ? { slot: Number(m[1]), auth: m[2], name: m[3], latency: Number(m[4]), level: m[5] }
    : null;
}
```

- [ ] **Step 4: Run and confirm passing**

From `daemon/`: `npx vitest run test/player-lines.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Substitution proof**

Delete the `normalize(` call from `parsePlayerConnecting` (leaving the raw `line`). Re-run. Expect RED, because the timestamp prefix no longer matches the anchored pattern. Restore, confirm green.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/player-lines.ts daemon/test/player-lines.test.ts
git commit -m "feat(daemon): parse the console lines that carry connection facts"
```

---

### Task 2: The roster

**Files:**
- Create: `daemon/src/player-roster.ts`
- Create: `daemon/test/player-roster.test.ts`
- Modify: `daemon/src/types.ts` (add `PlayerEntry`, extend `WsMessage`)
- Modify: `client/src/types.ts` (identical copy)

**Interfaces:**
- Consumes: every parser from Task 1.
- Produces:
  - `interface PlayerEntry { auth: string; name: string; slot: number | null; latency: number | null; level: string | null; joinedAt: string | null }`
  - `class PlayerRoster extends EventEmitter` with `observe(line: string): void`, `snapshot(): PlayerEntry[]`, `clear(): void`
  - Events: `"changed"` with no argument; `"reconcile"` with no argument, meaning "ask the server for /players".

- [ ] **Step 1: Add the shared types**

In `daemon/src/types.ts`, above `export type WsMessage`:

```typescript
/**
 * One player currently on the server.
 *
 * Keyed by `auth` because that is the only identifier present on both the
 * connect and the disconnect lines. `latency` and `level` come only from a
 * /players reconcile, and `joinedAt` is null when the daemon did not witness
 * the join - a player discovered by reconcile has no known join time, and
 * dating one from daemon start would read as playtime and be wrong.
 */
export interface PlayerEntry {
  auth: string;
  name: string;
  slot: number | null;
  latency: number | null;
  level: string | null;
  joinedAt: string | null;
}
```

And add one member to `WsMessage`:

```typescript
  | { type: "players"; players: PlayerEntry[] }
```

Copy the file verbatim to `client/src/types.ts` and confirm:

```bash
git hash-object daemon/src/types.ts client/src/types.ts
```

Both hashes must match.

- [ ] **Step 2: Write the failing tests**

Create `daemon/test/player-roster.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PlayerRoster } from "../src/player-roster.js";

const TS = "[2026-08-01 21:31:04] ";
const AUTH = "76561198048435182";

let roster: PlayerRoster;
beforeEach(() => {
  roster = new PlayerRoster();
});

/** Drives a full, ordinary join: the two lines the server prints, in order. */
function join(auth: string, name: string, slot: number): void {
  roster.observe(`${TS}Client "${auth}" with address 192.168.1.50:52134 is connecting with version 1.3.1.`);
  roster.observe(`${TS}Client "${name}" connected on slot ${slot}/5.`);
}

describe("joining", () => {
  it("lists a player after the connecting and connected lines", () => {
    join(AUTH, "Jeff", 1);
    expect(roster.snapshot()).toEqual([
      { auth: AUTH, name: "Jeff", slot: 1, latency: null, level: null, joinedAt: expect.any(String) },
    ]);
  });

  it("does not invent a name from the auth for a first-time player", () => {
    roster.observe(`${TS}Client "${AUTH}" with address LOCAL is connecting with version 1.3.1.`);
    roster.observe(`${TS}Client "${AUTH}" connected on slot 1/5.`);
    const [p] = roster.snapshot();
    expect(p.name).toBe("");
    expect(p.slot).toBe(1);
  });

  it("emits changed once per observed join", () => {
    const changed = vi.fn();
    roster.on("changed", changed);
    join(AUTH, "Jeff", 1);
    expect(changed).toHaveBeenCalled();
  });
});

describe("leaving", () => {
  it("removes a player on a clean quit", () => {
    join(AUTH, "Jeff", 1);
    roster.observe(`${TS}Player ${AUTH} ("Jeff") disconnected with message: Quit`);
    expect(roster.snapshot()).toEqual([]);
  });

  it("removes a player who timed out, which prints no disconnect line", () => {
    join(AUTH, "Jeff", 1);
    roster.observe(`${TS}Resetting connection for "Jeff" due to no packets received for 30000 ms.`);
    expect(roster.snapshot()).toEqual([]);
  });

  it("removes a player kicked for latency", () => {
    join(AUTH, "Jeff", 1);
    roster.observe(`${TS}Ping threshold for "Jeff" reached, resulting in kick. Limit is 60 seconds.`);
    expect(roster.snapshot()).toEqual([]);
  });

  /*
   * The ghost case this whole design exists for. A drop line names a player the
   * roster cannot match - the name was never learned, or the entry is already
   * gone - so the roster cannot know who left and asks the server instead.
   */
  it("asks for a reconcile when a drop line names nobody it knows", () => {
    const reconcile = vi.fn();
    roster.on("reconcile", reconcile);
    join(AUTH, "Jeff", 1);
    roster.observe(`${TS}Resetting connection for "Somebody Else" due to no packets received for 30000 ms.`);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(roster.snapshot()).toHaveLength(1);
  });
});

describe("reconcile", () => {
  it("replaces the roster wholesale from a /players block", () => {
    join(AUTH, "Jeff", 1);
    roster.observe(`${TS}Players online: 2/5`);
    roster.observe(`${TS}Slot 1: ${AUTH} "Jeff", latency: 42, level: surface,conn: 192.168.1.50:52134`);
    roster.observe(`${TS}Slot 2: 7656119800 "eli", latency: 31, level: cave,conn: LOCAL`);

    const names = roster.snapshot().map((p) => p.name);
    expect(names).toEqual(["Jeff", "eli"]);
  });

  it("keeps the join time it already knew and leaves the newcomer's null", () => {
    join(AUTH, "Jeff", 1);
    const before = roster.snapshot()[0].joinedAt;
    roster.observe(`${TS}Players online: 2/5`);
    roster.observe(`${TS}Slot 1: ${AUTH} "Jeff", latency: 42, level: surface,conn: LOCAL`);
    roster.observe(`${TS}Slot 2: 7656119800 "eli", latency: 31, level: cave,conn: LOCAL`);

    const byAuth = new Map(roster.snapshot().map((p) => [p.auth, p]));
    expect(byAuth.get(AUTH)?.joinedAt).toBe(before);
    expect(byAuth.get("7656119800")?.joinedAt).toBeNull();
  });

  it("drops a ghost that the server does not report", () => {
    join(AUTH, "Jeff", 1);
    join("7656119800", "eli", 2);
    roster.observe(`${TS}Players online: 1/5`);
    roster.observe(`${TS}Slot 1: ${AUTH} "Jeff", latency: 42, level: surface,conn: LOCAL`);

    expect(roster.snapshot().map((p) => p.auth)).toEqual([AUTH]);
  });

  it("empties the roster when the server reports nobody online", () => {
    join(AUTH, "Jeff", 1);
    roster.observe(`${TS}Players online: 0/5`);
    expect(roster.snapshot()).toEqual([]);
  });

  /*
   * A block is committed when its rows are all in, or when any other line
   * arrives. Without the second rule an interrupted block would hold the
   * roster hostage until the next reconcile.
   */
  it("commits a short block when an unrelated line interrupts it", () => {
    join(AUTH, "Jeff", 1);
    join("7656119800", "eli", 2);
    roster.observe(`${TS}Players online: 2/5`);
    roster.observe(`${TS}Slot 1: ${AUTH} "Jeff", latency: 42, level: surface,conn: LOCAL`);
    roster.observe(`${TS}Some unrelated server line.`);

    expect(roster.snapshot().map((p) => p.auth)).toEqual([AUTH]);
  });
});

describe("clear", () => {
  it("empties on demand, for when the process exits", () => {
    join(AUTH, "Jeff", 1);
    roster.clear();
    expect(roster.snapshot()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

From `daemon/`: `npx vitest run test/player-roster.test.ts`
Expected: FAIL, cannot resolve `../src/player-roster.js`.

- [ ] **Step 4: Implement the roster**

Create `daemon/src/player-roster.ts`:

```typescript
import { EventEmitter } from "node:events";
import {
  parsePlayerConnecting,
  parsePlayerConnected,
  parsePlayerDisconnected,
  parsePlayerDropped,
  parsePlayersHeader,
  parsePlayersRow,
} from "./player-lines.js";
import type { PlayerEntry } from "./types.js";

/**
 * Who is on the server, derived from its console output.
 *
 * Two kinds of input with different jobs. The connect and disconnect lines are
 * inference from log text and are what make a join appear immediately. A
 * /players block is the server stating its own roster, and is the only thing
 * that can clear a ghost left by a departure that printed nothing - timeouts,
 * kicks and shutdown all reach Server.disconnectClient directly.
 *
 * In memory only, by design: the roster is a fact about a running process.
 *
 * Emits "changed" when the snapshot differs, and "reconcile" when it has seen
 * something it cannot account for and wants the caller to run /players.
 */
export class PlayerRoster extends EventEmitter {
  private players = new Map<string, PlayerEntry>();
  /** Rows of a /players block in progress, or null when not inside one. */
  private incoming: { expected: number; rows: PlayerEntry[] } | null = null;

  observe(line: string): void {
    // A block in progress consumes rows first, so a row can never be mistaken
    // for anything else, and any other line ends the block.
    if (this.incoming !== null) {
      const row = parsePlayersRow(line);
      if (row !== null) {
        this.incoming.rows.push({
          auth: row.auth,
          name: row.name,
          slot: row.slot,
          latency: row.latency,
          level: row.level,
          joinedAt: this.players.get(row.auth)?.joinedAt ?? null,
        });
        if (this.incoming.rows.length >= this.incoming.expected) this.commitIncoming();
        return;
      }
      this.commitIncoming();
      // Falls through: the interrupting line may itself be meaningful.
    }

    const header = parsePlayersHeader(line);
    if (header !== null) {
      this.incoming = { expected: header.online, rows: [] };
      if (header.online === 0) this.commitIncoming();
      return;
    }

    const connecting = parsePlayerConnecting(line);
    if (connecting !== null) {
      this.upsert({
        auth: connecting.auth,
        name: "",
        slot: null,
        latency: null,
        level: null,
        joinedAt: new Date().toISOString(),
      });
      return;
    }

    const connected = parsePlayerConnected(line);
    if (connected !== null) {
      this.applyConnected(connected.consoleName, connected.slot);
      return;
    }

    const gone = parsePlayerDisconnected(line);
    if (gone !== null) {
      if (this.players.delete(gone.auth)) this.emit("changed");
      return;
    }

    const dropped = parsePlayerDropped(line);
    if (dropped !== null) this.applyDropped(dropped.name);
  }

  snapshot(): PlayerEntry[] {
    return Array.from(this.players.values()).map((p) => ({ ...p }));
  }

  clear(): void {
    if (this.players.size === 0 && this.incoming === null) return;
    this.players.clear();
    this.incoming = null;
    this.emit("changed");
  }

  /**
   * The console name is the stored player name only once the world knows the
   * player; for a first-time join it is the numeric auth. Matching it against
   * the pending entry's auth is what keeps a Steam id out of the name column.
   */
  private applyConnected(consoleName: string, slot: number): void {
    const pending = this.mostRecentWithoutSlot();
    if (pending === null) {
      // No connecting line seen - the daemon attached mid-session, or a line
      // was lost. The server knows; ask it rather than guess an identity.
      this.emit("reconcile");
      return;
    }
    pending.slot = slot;
    if (consoleName !== pending.auth) pending.name = consoleName;
    this.emit("changed");
  }

  private applyDropped(name: string): void {
    for (const [auth, p] of this.players) {
      if (p.name === name) {
        this.players.delete(auth);
        this.emit("changed");
        return;
      }
    }
    this.emit("reconcile");
  }

  private mostRecentWithoutSlot(): PlayerEntry | null {
    let found: PlayerEntry | null = null;
    for (const p of this.players.values()) {
      if (p.slot === null) found = p;
    }
    return found;
  }

  private upsert(entry: PlayerEntry): void {
    const existing = this.players.get(entry.auth);
    this.players.set(entry.auth, existing ? { ...existing, ...entry, joinedAt: existing.joinedAt } : entry);
    this.emit("changed");
  }

  private commitIncoming(): void {
    if (this.incoming === null) return;
    const rows = this.incoming.rows;
    this.incoming = null;
    this.players = new Map(rows.map((r) => [r.auth, r]));
    this.emit("changed");
  }
}
```

- [ ] **Step 5: Run and confirm passing**

From `daemon/`: `npx vitest run test/player-roster.test.ts` then `npx vitest run` and `npx tsc --noEmit`.
Expected: all PASS, tsc clean.

- [ ] **Step 6: Substitution proof**

In `commitIncoming`, replace the wholesale rebuild with a merge that only adds:

```typescript
    for (const r of rows) this.players.set(r.auth, r);
```

Re-run `test/player-roster.test.ts`. Expect RED on "drops a ghost that the server does not report" and "empties the roster when the server reports nobody online" - those two tests are the entire point of reconcile, and a merge passes every other test in the file. Restore, confirm green.

- [ ] **Step 7: Commit**

```bash
git add daemon/src/player-roster.ts daemon/test/player-roster.test.ts daemon/src/types.ts client/src/types.ts
git commit -m "feat(daemon): track who is on the server, reconciled against /players"
```

---

### Task 3: Sending a line to the server

**Files:**
- Modify: `daemon/src/process-manager.ts` (add `send`, beside `stop`)
- Modify: `daemon/test/process-manager.test.ts`

**Interfaces:**
- Produces: `ProcessManager.send(command: string): void` - writes one line to the child's stdin. Throws rather than returning a result, so a caller cannot ignore it.

Phase 2 uses this for every command. This task adds only the transport and its refusals, and the roster uses it for `/players`.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/process-manager.test.ts`, matching the file's existing harness for building a manager with a fake child:

```typescript
describe("send", () => {
  it("writes the command as one line to stdin", async () => {
    const { pm, child } = await startedManager();
    pm.send("/players");
    expect(child.stdin.written).toEqual(["/players\n"]);
  });

  it("refuses when the server is not running", () => {
    const pm = newManager();
    expect(() => pm.send("/players")).toThrow(/not running/i);
  });

  // Same distinction stop already draws: an adopted server has no stdin pipe,
  // so this is not a transient failure and must not read like one.
  it("refuses on a server this daemon did not start", async () => {
    const pm = await unmanagedManager();
    expect(() => pm.send("/players")).toThrow(/not started by this daemon/i);
  });

  it("refuses a command containing a newline", async () => {
    const { pm, child } = await startedManager();
    expect(() => pm.send("/say hi\n/allowcheats")).toThrow(/single line/i);
    expect(child.stdin.written).toEqual([]);
  });
});
```

If `startedManager`, `newManager` or `unmanagedManager` do not already exist in that file under those names, use whatever the file's existing helpers are called and keep the assertions identical. Read the file before writing the test.

- [ ] **Step 2: Run and confirm failure**

From `daemon/`: `npx vitest run test/process-manager.test.ts -t "send"`
Expected: FAIL, `pm.send is not a function`.

- [ ] **Step 3: Implement send**

In `daemon/src/process-manager.ts`, directly above `stop()`:

```typescript
  /**
   * Writes one line to the server's stdin.
   *
   * The newline guard is not defensive: stdin is line-oriented, so a command
   * carrying one would run as two commands, which is how a value like
   * `hi\n/allowcheats` turns a chat message into a cheat. The daemon validates
   * arguments before it composes a command, and this is the last gate before
   * the wire.
   */
  send(command: string): void {
    if (/[\r\n]/.test(command)) {
      throw new Error(`A command must be a single line, and this one is not: ${JSON.stringify(command)}`);
    }
    if (this.state === "unmanaged") {
      throw new Error(
        `The running server (pid ${this.externalPid}) was not started by this daemon, ` +
          `so there is no stdin pipe to send commands to.`,
      );
    }
    if (!this.child || this.state !== "running") {
      throw new Error(`Server is not running (state: ${this.state}).`);
    }
    try {
      this.child.stdin.write(`${command}\n`);
    } catch (e) {
      throw new Error(`Failed to write to server stdin: ${(e as Error).message}`);
    }
  }
```

- [ ] **Step 4: Run and confirm passing**

From `daemon/`: `npx vitest run` and `npx tsc --noEmit`.

- [ ] **Step 5: Substitution proof**

Delete the newline guard. Re-run; expect RED on "refuses a command containing a newline". Restore.

- [ ] **Step 6: Commit**

```bash
git add daemon/src/process-manager.ts daemon/test/process-manager.test.ts
git commit -m "feat(daemon): send a single line to the running server"
```

---

### Task 4: Wire the roster into the daemon

**Files:**
- Modify: `daemon/src/index.ts` (construct the roster, pass to `buildServer`)
- Modify: `daemon/src/http.ts` (deps, subscriptions, two routes, broadcast)
- Modify: `daemon/test/http.test.ts`

**Interfaces:**
- Consumes: `PlayerRoster` (Task 2), `ProcessManager.send` (Task 3).
- Produces:
  - `GET /api/players` -> `{ ok: true, players: PlayerEntry[] }`
  - `POST /api/players/refresh` -> `{ ok: true }`, or `{ ok: false, error }` when the server is not running.
  - WebSocket `{ type: "players", players }` on every roster change.

- [ ] **Step 1: Write the failing tests**

Add to `daemon/test/http.test.ts`:

```typescript
describe("players", () => {
  it("reports an empty roster before anyone joins", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "GET", url: "/api/players" });
    expect(res.json()).toEqual({ ok: true, players: [] });
  });

  it("reports a player the server said connected", async () => {
    const { app, pm } = await build();
    await startServer(pm);
    pm.feedLine(`[2026-08-01 21:31:04] Client "7656119801" with address LOCAL is connecting with version 1.3.1.`);
    pm.feedLine(`[2026-08-01 21:31:04] Client "Jeff" connected on slot 1/5.`);

    const res = await app.inject({ method: "GET", url: "/api/players" });
    expect(res.json().players).toMatchObject([{ auth: "7656119801", name: "Jeff", slot: 1 }]);
  });

  it("empties the roster when the server exits", async () => {
    const { app, pm } = await build();
    await startServer(pm);
    pm.feedLine(`[2026-08-01 21:31:04] Client "7656119801" with address LOCAL is connecting with version 1.3.1.`);
    pm.feedLine(`[2026-08-01 21:31:04] Client "Jeff" connected on slot 1/5.`);
    await stopServer(pm);

    const res = await app.inject({ method: "GET", url: "/api/players" });
    expect(res.json().players).toEqual([]);
  });

  it("asks the server for /players on refresh", async () => {
    const { app, pm, child } = await build();
    await startServer(pm);
    const res = await app.inject({ method: "POST", url: "/api/players/refresh" });
    expect(res.json()).toEqual({ ok: true });
    expect(child.stdin.written).toContain("/players\n");
  });

  it("refuses a refresh when the server is not running, saying why", async () => {
    const { app } = await build();
    const res = await app.inject({ method: "POST", url: "/api/players/refresh" });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not running/i);
  });
});
```

Use the file's existing helpers for building the app and driving the process manager. Read the top of `daemon/test/http.test.ts` first and match its names; if there is no way to feed a console line to the fake child, add one in the same style the file already uses rather than inventing a second mechanism.

- [ ] **Step 2: Run and confirm failure**

From `daemon/`: `npx vitest run test/http.test.ts -t "players"`
Expected: FAIL, 404 on `/api/players`.

- [ ] **Step 3: Construct the roster in index.ts**

In `daemon/src/index.ts`, after the `ProcessManager` is created and before `buildServer`:

```typescript
// Fed by the same "line" stream the console panel is built from, so the roster
// costs no extra pipe out of the game process.
const playerRoster = new PlayerRoster();
```

Add `playerRoster` to the object passed to `buildServer`, and import it from `./player-roster.js`.

- [ ] **Step 4: Wire it in http.ts**

Add `playerRoster: PlayerRoster` to `Deps` and destructure it. Then, beside the existing `pm.on("line", ...)` at the top of `buildServer`:

```typescript
  // The roster reads the same lines the console does. Registered after the
  // console broadcast so a parse failure can never cost the operator their log.
  pm.on("line", (l) => playerRoster.observe(l.line));
  pm.on("state", (status) => {
    if (status.state === "stopped" || status.state === "unmanaged") playerRoster.clear();
  });
  playerRoster.on("changed", () => broadcast({ type: "players", players: playerRoster.snapshot() }));
  playerRoster.on("reconcile", () => {
    // Best effort: the roster asks whenever it sees something it cannot
    // account for, and the server may already be gone by then. A failed
    // reconcile leaves the roster exactly as it was.
    try {
      pm.send("/players");
    } catch {
      // Intentionally ignored: `send` throws only when there is no server to
      // ask, which is not a condition the operator can act on.
    }
  });
```

Add the two routes near `/api/status`:

```typescript
  app.get("/api/players", async () => ({ ok: true, players: playerRoster.snapshot() }));

  app.post("/api/players/refresh", async (_req, reply) => {
    try {
      pm.send("/players");
    } catch (e) {
      return reply.send({ ok: false, error: (e as Error).message });
    }
    return { ok: true };
  });
```

Also send the roster in the socket's opening `backlog` message so a client that connects mid-session is not blank until the next change: add `players: playerRoster.snapshot()` to that payload and to the `backlog` member of `WsMessage` in both `types.ts` files.

- [ ] **Step 5: Reconcile once when the server becomes ready**

In the existing `pm.on("state", ...)` handler in `http.ts`, where `status.state === "running"` is already handled, add:

```typescript
    if (status.state === "running") {
      // The server has just announced itself. Anyone already on - a daemon
      // restart against a live server - is invisible until it is asked.
      try {
        pm.send("/players");
      } catch {
        // See the reconcile handler above.
      }
    }
```

- [ ] **Step 6: Run and confirm passing**

From `daemon/`: `npx vitest run` and `npx tsc --noEmit`. Then from `client/`: `npx tsc --noEmit`, which typechecks the daemon a second time under ES2020.

- [ ] **Step 7: Commit**

```bash
git add daemon/src/index.ts daemon/src/http.ts daemon/test/http.test.ts daemon/src/types.ts client/src/types.ts
git commit -m "feat(daemon): serve the player roster over HTTP and the websocket"
```

---

### Task 5: Client transport and state

**Files:**
- Modify: `client/src/api.ts`
- Modify: `client/src/useDaemon.ts`
- Modify: `client/test/api.test.ts`
- Modify: `client/test/useDaemon.test.ts`

**Interfaces:**
- Produces:
  - `api.getPlayers(): Promise<{ ok: boolean; players: PlayerEntry[] }>`
  - `api.refreshPlayers(): Promise<{ ok: boolean; error?: string }>`
  - `DaemonState.players: PlayerEntry[]`

- [ ] **Step 1: Write the failing tests**

In `client/test/useDaemon.test.ts`, matching the file's existing style for pushing a socket message:

```typescript
it("puts the roster on state when the daemon sends one", async () => {
  const { result, socket } = renderDaemon();
  socket.emitMessage({
    type: "players",
    players: [{ auth: "7656119801", name: "Jeff", slot: 1, latency: 42, level: "surface", joinedAt: null }],
  });
  await waitFor(() => expect(result.current.players).toHaveLength(1));
  expect(result.current.players[0].name).toBe("Jeff");
});

it("takes the roster from the opening backlog too", async () => {
  const { result, socket } = renderDaemon();
  socket.emitMessage({
    type: "backlog",
    lines: [],
    status: stoppedStatus(),
    players: [{ auth: "7656119801", name: "eli", slot: 2, latency: null, level: null, joinedAt: null }],
  });
  await waitFor(() => expect(result.current.players.map((p) => p.name)).toEqual(["eli"]));
});
```

In `client/test/api.test.ts`, add a case for each new call following the file's existing pattern for asserting method, path and headers.

- [ ] **Step 2: Run and confirm failure**

From `client/`: `npx vitest run test/useDaemon.test.ts test/api.test.ts`
Expected: FAIL, `result.current.players` is undefined.

- [ ] **Step 3: Implement**

In `client/src/api.ts`, following the shape of the existing calls exactly:

```typescript
export async function getPlayers(conn: Connection): Promise<{ ok: boolean; players: PlayerEntry[] }> {
  return request(conn, "GET", "/api/players");
}

export async function refreshPlayers(conn: Connection): Promise<{ ok: boolean; error?: string }> {
  return request(conn, "POST", "/api/players/refresh");
}
```

Use whatever the file's real request helper is named and match how the other calls pass method and path; do not introduce a second way of making a request.

In `client/src/useDaemon.ts`, add `players` to the state (initial `[]`), set it from both the `players` and `backlog` messages, and clear it when the socket closes, since a roster with no live connection behind it is a claim the client can no longer support.

- [ ] **Step 4: Run and confirm passing**

From `client/`: `npx vitest run` and `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add client/src/api.ts client/src/useDaemon.ts client/test/api.test.ts client/test/useDaemon.test.ts
git commit -m "feat(client): carry the player roster into daemon state"
```

---

### Task 6: The Players tab

**Files:**
- Create: `client/src/PlayersPanel.tsx`
- Create: `client/test/PlayersPanel.test.tsx`
- Modify: `client/src/App.tsx` (tab strip over the left column)
- Modify: `client/src/App.css`
- Modify: `client/test/App.test.tsx`

**Interfaces:**
- Consumes: `DaemonState.players` (Task 5), `refreshPlayers` (Task 5).
- Produces: `<PlayersPanel players={...} serverRunning={...} onRefresh={...} />`

- [ ] **Step 1: Write the failing tests**

Create `client/test/PlayersPanel.test.tsx`. Assert on what the operator sees, per this project's testing rules:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlayersPanel } from "../src/PlayersPanel";
import type { PlayerEntry } from "../src/types";

const jeff: PlayerEntry = {
  auth: "7656119801", name: "Jeff", slot: 1, latency: 42, level: "surface",
  joinedAt: new Date(Date.now() - 3_600_000).toISOString(),
};

describe("PlayersPanel", () => {
  it("lists who is on", () => {
    render(<PlayersPanel players={[jeff]} serverRunning={true} onRefresh={vi.fn()} />);
    expect(screen.getByText("Jeff")).toBeInTheDocument();
    expect(screen.getByText(/42/)).toBeInTheDocument();
  });

  it("says nobody is on rather than showing an empty box", () => {
    render(<PlayersPanel players={[]} serverRunning={true} onRefresh={vi.fn()} />);
    expect(screen.getByText(/no players online/i)).toBeInTheDocument();
  });

  it("says the server is stopped, which is a different thing from nobody being on", () => {
    render(<PlayersPanel players={[]} serverRunning={false} onRefresh={vi.fn()} />);
    expect(screen.getByText(/server is stopped/i)).toBeInTheDocument();
  });

  // The honest gap: a player found by reconcile has no known join time.
  it("shows a dash rather than inventing a session length", () => {
    render(
      <PlayersPanel players={[{ ...jeff, joinedAt: null }]} serverRunning={true} onRefresh={vi.fn()} />,
    );
    expect(screen.getByText("-")).toBeInTheDocument();
  });

  it("refreshes on request", async () => {
    const onRefresh = vi.fn();
    render(<PlayersPanel players={[jeff]} serverRunning={true} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
```

In `client/test/App.test.tsx`, add one test that the Players tab exists and switches the left column to the roster.

- [ ] **Step 2: Run and confirm failure**

From `client/`: `npx vitest run test/PlayersPanel.test.tsx`
Expected: FAIL, cannot resolve `../src/PlayersPanel`.

- [ ] **Step 3: Implement the panel**

Create `client/src/PlayersPanel.tsx`. Use real semantic elements (a `<table>` with a header row, a `<button>` for refresh), match the class-naming and layout conventions in `ModsPanel.tsx`, and render session length from `joinedAt` with a `-` when it is null. Keep the columns to name, slot, session, latency and level.

- [ ] **Step 4: Add the tab strip**

In `client/src/App.tsx`, wrap the existing `<ModsPanel .../>` in a tab container with `Mods` and `Players`, keeping `ModsPanel` mounted (its state and in-flight work should survive a tab switch) and hiding it with CSS rather than unmounting. Wire `onRefresh` to `refreshPlayers`.

- [ ] **Step 5: Run and confirm passing**

From `client/`: `npx vitest run` and `npx tsc --noEmit`.

- [ ] **Step 6: Substitution proof**

Change the `joinedAt === null` branch to render `0m` instead of `-`. Re-run; expect RED on "shows a dash rather than inventing a session length". Restore.

- [ ] **Step 7: Commit**

```bash
git add client/src/PlayersPanel.tsx client/test/PlayersPanel.test.tsx client/src/App.tsx client/src/App.css client/test/App.test.tsx
git commit -m "feat(client): a Players tab beside Mods"
```

---

### Task 7: The seam, real fixtures, and the docs

**Files:**
- Modify: `client/test/api.integration.test.ts`
- Modify: `daemon/test/fixtures/log-fixtures.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Add the seam test**

In `client/test/api.integration.test.ts`, following the file's existing pattern of standing up a real daemon on an ephemeral port and driving it with the real client transport, add a test that feeds two connect lines into the real `ProcessManager` and asserts `getPlayers` returns the roster through the real client API layer. Do not hand-build the URL and do not mock either side; this file exists because the daemon's `inject()` tests never set a content-type and the client's mocked `fetch` never reaches Fastify.

Add a second seam test asserting `refreshPlayers` against a stopped server returns `ok: false` with a message, since that is a bodyless POST - exactly the shape that once shipped broken.

- [ ] **Step 2: Capture real 1.3.1 output**

This step needs the operator for about two minutes and cannot be faked.

1. Start a world from the client.
2. Join it, then quit cleanly.
3. From the workstation, read `C:\Users\jeffp\AppData\Roaming\Necesse\latest-server-log.txt` over SSH and copy the real connect, connected and disconnect lines verbatim.
4. With the server still running, `POST /api/players/refresh` and copy the real `/players` header and rows verbatim.

Add them to `daemon/test/fixtures/log-fixtures.ts` as a `PLAYER_LINES` export, with a comment recording the game version and the date they were captured. Do not reformat them; this file is evidence.

- [ ] **Step 3: Prove the parsers against the captured lines**

Add a test in `daemon/test/player-lines.test.ts` that runs each captured line through its parser and asserts the expected fields. If a captured line does not match, the parser is wrong and the captured line wins.

- [ ] **Step 4: Run everything**

From `daemon/`: `npx vitest run` and `npx tsc --noEmit`. From `client/`: `npx vitest run` and `npx tsc --noEmit`. All four clean.

- [ ] **Step 5: Update the README**

In the section describing the client's panels, document the Players tab: what it shows, that it is derived from the server's console output, that it empties when the server stops, that a session length is only shown when the daemon witnessed the join, and that Refresh asks the server directly. Plain ASCII punctuation.

- [ ] **Step 6: Commit**

```bash
git add client/test/api.integration.test.ts daemon/test/fixtures/log-fixtures.ts daemon/test/player-lines.test.ts README.md
git commit -m "test: prove the roster across the seam and against captured 1.3.1 output"
```

---

## Self-Review

**Spec coverage.** Roster derivation and its two input kinds: Tasks 1 and 2. Keyed by auth, with the first-time-player case: Tasks 1 and 2. Reconcile on events and never on a timer: Task 4 (ready, unattributable line, explicit refresh) - there is no timer anywhere in the plan. Cleared on process exit: Tasks 2 and 4. `PlayerEntry` shape including the null `joinedAt`: Task 2, rendered in Task 6. Roster as its own WebSocket message rather than on `StatusPayload`: Task 4. Tab beside Mods: Task 6. `ProcessManager.send` with its two refusals: Task 3. Captured fixtures and the ANSI/timestamp handling: Global Constraints, Tasks 1 and 7. Seam test: Task 7. `types.ts` hashed: Task 2 step 1. The command system is deliberately absent - it is phase 2.

**Placeholder scan.** No TBD or "handle edge cases". Three steps deliberately say "match the file's existing helpers" (Task 3 step 1, Task 4 step 1, Task 5 step 3) rather than reproducing test harnesses this plan cannot see; each names the file to read first and states the assertions exactly. Task 6 step 3 describes the panel's columns and required semantics rather than dictating markup, because it must match `ModsPanel.tsx`, which is not reproduced here.

**Type consistency.** `PlayerEntry` has the same six fields in Tasks 2, 4, 5 and 6. `parsePlayersRow` returns `{ slot, auth, name, latency, level }` in Task 1 and is destructured with exactly those names in Task 2. `PlayerRoster` exposes `observe`/`snapshot`/`clear` and emits `changed`/`reconcile` consistently in Tasks 2 and 4. `send(command: string): void` throws in Task 3 and every caller in Task 4 wraps it in try/catch accordingly.

**One correction made during review.** An earlier draft had the roster emit `reconcile` from `applyConnected` whenever the console name did not match a pending entry, which would fire on every first-time player join - the exact case where the console name is the auth. It now emits only when there is no pending entry at all.
