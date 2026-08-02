import { describe, it, expect } from "vitest";
import {
  parsePlayerConnecting,
  parsePlayerConnected,
  parsePlayerDisconnected,
  parsePlayerDropped,
  parsePlayerLoaded,
  parsePlayersHeader,
  parsePlayersRow,
} from "../src/player-lines.js";
import * as F from "./fixtures/log-fixtures.js";

// Every input carries the timestamp prefix, because that is how the lines
// really arrive: ProcessManager strips ANSI before recording, but not this.
const TS = "[2026-08-01 21:31:04] ";

describe("parsePlayerConnecting", () => {
  it("takes the auth off the only line that always carries it", () => {
    const r = parsePlayerConnecting(
      `${TS}Client "76561198048435182" with address 192.168.1.50:52134 is connecting with version 1.3.1.`,
    );
    expect(r).toEqual({ auth: "76561198048435182" });
  });

  it("reads a LOCAL address the same way", () => {
    const r = parsePlayerConnecting(
      `${TS}Client "76561198048435182" with address LOCAL is connecting with version 1.3.1.`,
    );
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

  it("is null for the already-connected line, which is not a join", () => {
    expect(
      parsePlayerConnected(`${TS}Client "Jeff" is already connected. Sending another approved packet...`),
    ).toBeNull();
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

  // The near-miss lines from the same method. Both report a rejected request,
  // not a departure, so neither may close an entry.
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

  it("is null for an unrelated line", () => {
    expect(parsePlayerDropped(`${TS}Server has stopped`)).toBeNull();
  });
});

/*
 * The parsers above were written from the game's format strings. These run
 * them against output the live 1.3.1 server actually produced, which is the
 * only thing that proves the two agree.
 */
describe("captured 1.3.1 output", () => {
  it("reads the real connecting line", () => {
    expect(parsePlayerConnecting(F.REAL_CONNECTING)).toEqual({ auth: "76561198048435182" });
  });

  it("reads the real connected line", () => {
    expect(parsePlayerConnected(F.REAL_CONNECTED)).toEqual({
      consoleName: "Jeff",
      slot: 1,
      slots: 5,
    });
  });

  it("reads the real disconnect line, whose reason is the word Quit", () => {
    expect(parsePlayerDisconnected(F.REAL_DISCONNECTED)).toEqual({
      auth: "76561198048435182",
      name: "Jeff",
      reason: "Quit",
    });
  });

  it("reads the real /players answer for an empty server", () => {
    expect(parsePlayersHeader(F.REAL_PLAYERS_EMPTY)).toEqual({ online: 0, slots: 5 });
  });

  // The console echoes the command back before answering. It must not be
  // mistaken for part of the answer.
  it("reads nothing out of the console's echo of the command", () => {
    expect(parsePlayersHeader(F.REAL_PLAYERS_ECHO)).toBeNull();
    expect(parsePlayersRow(F.REAL_PLAYERS_ECHO)).toBeNull();
    expect(parsePlayerConnecting(F.REAL_PLAYERS_ECHO)).toBeNull();
  });

  it("reads the real /players row, latency 0 and all", () => {
    expect(parsePlayersHeader(F.REAL_PLAYERS_ONE)).toEqual({ online: 1, slots: 5 });
    expect(parsePlayersRow(F.REAL_PLAYERS_ROW)).toEqual({
      slot: 1,
      auth: "76561198048435182",
      name: "Jeff",
      latency: 0,
      level: "surface",
    });
  });

  it("reads the real loaded-player line", () => {
    expect(parsePlayerLoaded(F.REAL_PLAYER_LOADED)).toEqual({ auth: "76561198048435182" });
  });

  it("pairs the real join and the real quit on the same auth", () => {
    const joined = parsePlayerConnecting(F.REAL_CONNECTING);
    const left = parsePlayerDisconnected(F.REAL_DISCONNECTED);
    expect(joined?.auth).toBe(left?.auth);
  });
});

describe("/players output", () => {
  it("reads the header", () => {
    expect(parsePlayersHeader(`${TS}Players online: 2/5`)).toEqual({ online: 2, slots: 5 });
  });

  it("reads a row, including the level that has no space after its comma", () => {
    expect(
      parsePlayersRow(
        `${TS}Slot 1: 76561198048435182 "Jeff", latency: 42, level: surface,conn: 192.168.1.50:52134`,
      ),
    ).toEqual({ slot: 1, auth: "76561198048435182", name: "Jeff", latency: 42, level: "surface" });
  });

  it("reads a row whose level identifier contains commas and spaces", () => {
    const r = parsePlayersRow(`${TS}Slot 2: 7656119800 "eli", latency: 31, level: island 12, 8 cave,conn: LOCAL`);
    expect(r?.level).toBe("island 12, 8 cave");
    expect(r?.name).toBe("eli");
  });

  it("reads a name containing a comma", () => {
    const r = parsePlayersRow(`${TS}Slot 3: 7656119801 "Bob, the Builder", latency: 5, level: surface,conn: LOCAL`);
    expect(r?.name).toBe("Bob, the Builder");
  });
});
