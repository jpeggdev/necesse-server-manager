import { EventEmitter } from "node:events";
import {
  parsePlayerConnecting,
  parsePlayerConnected,
  parsePlayerDisconnected,
  parsePlayerDropped,
  parsePlayerLoaded,
  parsePlayersHeader,
  parsePlayersRow,
} from "./player-lines.js";
import type { PlayerEntry } from "./types.js";

/**
 * Who is on the server, derived from its console output.
 *
 * Two kinds of input doing different jobs. The connect and disconnect lines
 * are inference from log text, and are what make a join appear the moment it
 * happens. A `/players` block is the server stating its own roster, and is the
 * only thing that can clear a ghost left by a departure that printed nothing:
 * timeouts, kicks and shutdown all reach `Server.disconnectClient` directly,
 * which prints no per-player line.
 *
 * In memory only, by design. The roster is a fact about a running process, so
 * there is nothing to persist and nothing to migrate.
 *
 * Emits `changed` when the snapshot differs, and `reconcile` when it has seen
 * something it cannot account for and wants the caller to run `/players`.
 */
export class PlayerRoster extends EventEmitter {
  private players = new Map<string, PlayerEntry>();
  /** Rows of a `/players` block in progress, or null when not inside one. */
  private incoming: { expected: number; rows: PlayerEntry[] } | null = null;

  observe(line: string): void {
    // A block in progress claims rows first, so a row can never be mistaken for
    // anything else. Any other line ends the block, and then falls through to
    // be read on its own merits - a join announced right after a short block
    // must not be swallowed by it.
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
    }

    const header = parsePlayersHeader(line);
    if (header !== null) {
      this.incoming = { expected: header.online, rows: [] };
      // "0/5" has no rows to wait for, and waiting would leave the block open
      // until some unrelated line closed it.
      if (header.online === 0) this.commitIncoming();
      return;
    }

    const connecting = parsePlayerConnecting(line);
    if (connecting !== null) {
      this.open(connecting.auth);
      return;
    }

    const connected = parsePlayerConnected(line);
    if (connected !== null) {
      this.applyConnected(connected.consoleName, connected.slot);
      return;
    }

    const loaded = parsePlayerLoaded(line);
    if (loaded !== null) {
      // Confirmation, not a join: re-opens an entry that a stale disconnect
      // removed, and leaves an existing one (including its join time) alone.
      if (!this.players.has(loaded.auth)) this.open(loaded.auth);
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

  private open(auth: string): void {
    const existing = this.players.get(auth);
    this.players.set(auth, {
      auth,
      name: existing?.name ?? "",
      slot: null,
      latency: existing?.latency ?? null,
      level: existing?.level ?? null,
      joinedAt: existing?.joinedAt ?? new Date().toISOString(),
    });
    this.emit("changed");
  }

  /**
   * The console name is the stored player name only once the world knows the
   * player; for a first-time join it is the numeric auth. Comparing it against
   * the pending entry's auth is what keeps a Steam id out of the name column.
   */
  private applyConnected(consoleName: string, slot: number): void {
    const pending = this.mostRecentWithoutSlot();
    if (pending === null) {
      // No connecting line preceded this, so the daemon attached mid-session or
      // a line was lost. The server knows who is on; ask rather than guess.
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

  private commitIncoming(): void {
    if (this.incoming === null) return;
    const rows = this.incoming.rows;
    this.incoming = null;
    this.players = new Map(rows.map((r) => [r.auth, r]));
    this.emit("changed");
    // Distinct from "changed": this fires only when the SERVER answered, which
    // is what tells a caller its question landed. A command sent while the
    // world is still initialising is echoed to the console and then does
    // nothing at all, so "we sent it" is not evidence that it ran.
    this.emit("reconciled");
  }
}
