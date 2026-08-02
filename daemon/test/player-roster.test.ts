import { describe, it, expect, beforeEach, vi } from "vitest";
import { PlayerRoster } from "../src/player-roster.js";

const TS = "[2026-08-01 21:31:04] ";
const AUTH = "76561198048435182";

let roster: PlayerRoster;
beforeEach(() => {
  roster = new PlayerRoster();
});

/** An ordinary join: the two lines the server prints, in the order it prints them. */
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

  it("emits changed when someone joins", () => {
    const changed = vi.fn();
    roster.on("changed", changed);
    join(AUTH, "Jeff", 1);
    expect(changed).toHaveBeenCalled();
  });

  it("tracks two players independently", () => {
    join(AUTH, "Jeff", 1);
    join("7656119800", "eli", 2);
    expect(roster.snapshot().map((p) => [p.name, p.slot])).toEqual([
      ["Jeff", 1],
      ["eli", 2],
    ]);
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
   * The ghost case this design exists for. A drop line names somebody the
   * roster cannot match, so it cannot know who left and asks the server rather
   * than guessing or silently doing nothing.
   */
  it("asks for a reconcile when a drop line names nobody it knows", () => {
    const reconcile = vi.fn();
    roster.on("reconcile", reconcile);
    join(AUTH, "Jeff", 1);
    roster.observe(`${TS}Resetting connection for "Somebody Else" due to no packets received for 30000 ms.`);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(roster.snapshot()).toHaveLength(1);
  });

  it("asks for a reconcile when a slot line arrives with no connect before it", () => {
    const reconcile = vi.fn();
    roster.on("reconcile", reconcile);
    roster.observe(`${TS}Client "Jeff" connected on slot 1/5.`);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

describe("reconcile", () => {
  it("replaces the roster wholesale from a /players block", () => {
    join(AUTH, "Jeff", 1);
    roster.observe(`${TS}Players online: 2/5`);
    roster.observe(`${TS}Slot 1: ${AUTH} "Jeff", latency: 42, level: surface,conn: 192.168.1.50:52134`);
    roster.observe(`${TS}Slot 2: 7656119800 "eli", latency: 31, level: cave,conn: LOCAL`);

    expect(roster.snapshot().map((p) => p.name)).toEqual(["Jeff", "eli"]);
  });

  it("fills in latency and level, which no connect line carries", () => {
    join(AUTH, "Jeff", 1);
    roster.observe(`${TS}Players online: 1/5`);
    roster.observe(`${TS}Slot 1: ${AUTH} "Jeff", latency: 42, level: surface,conn: LOCAL`);

    expect(roster.snapshot()[0]).toMatchObject({ latency: 42, level: "surface" });
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

  it("drops a ghost the server does not report", () => {
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
   * A block commits when its rows are all in, or when any other line arrives.
   * Without the second rule an interrupted block would hold the roster hostage
   * until the next reconcile.
   */
  it("commits a short block when an unrelated line interrupts it", () => {
    join(AUTH, "Jeff", 1);
    join("7656119800", "eli", 2);
    roster.observe(`${TS}Players online: 2/5`);
    roster.observe(`${TS}Slot 1: ${AUTH} "Jeff", latency: 42, level: surface,conn: LOCAL`);
    roster.observe(`${TS}Some unrelated server line.`);

    expect(roster.snapshot().map((p) => p.auth)).toEqual([AUTH]);
  });

  it("still sees a join that arrives immediately after an interrupted block", () => {
    roster.observe(`${TS}Players online: 2/5`);
    roster.observe(`${TS}Slot 1: ${AUTH} "Jeff", latency: 42, level: surface,conn: LOCAL`);
    roster.observe(`${TS}Client "7656119800" with address LOCAL is connecting with version 1.3.1.`);
    roster.observe(`${TS}Client "eli" connected on slot 2/5.`);

    expect(roster.snapshot().map((p) => p.name)).toEqual(["Jeff", "eli"]);
  });
});

/*
 * One act of joining can produce more than one connection: the client connects
 * to check mods, then connects again once a character is chosen. If the first
 * connection's disconnect arrives after the second is up, a roster keyed by
 * authentication drops somebody who is on. "Loaded player" is the game saying
 * they are in the world, and it is what puts them back.
 */
describe("a join that connects more than once", () => {
  it("stays listed when a stale disconnect lands after the real connection", () => {
    join(AUTH, "Jeff", 1);
    roster.observe(`${TS}Player ${AUTH} ("Jeff") disconnected with message: Quit`);
    expect(roster.snapshot()).toEqual([]);

    roster.observe(`${TS}Loaded player: ${AUTH}`);
    expect(roster.snapshot().map((p) => p.auth)).toEqual([AUTH]);
  });

  it("does not disturb a player it already knows about", () => {
    join(AUTH, "Jeff", 1);
    const before = roster.snapshot()[0];
    roster.observe(`${TS}Loaded player: ${AUTH}`);
    expect(roster.snapshot()).toEqual([before]);
  });

  it("treats a repeated connect for the same auth as the same player", () => {
    join(AUTH, "Jeff", 1);
    const first = roster.snapshot()[0].joinedAt;
    join(AUTH, "Jeff", 1);
    const after = roster.snapshot();
    expect(after).toHaveLength(1);
    expect(after[0].joinedAt).toBe(first);
  });
});

describe("clear", () => {
  it("empties on demand, for when the process exits", () => {
    join(AUTH, "Jeff", 1);
    roster.clear();
    expect(roster.snapshot()).toEqual([]);
  });

  it("emits nothing when there was nothing to clear", () => {
    const changed = vi.fn();
    roster.on("changed", changed);
    roster.clear();
    expect(changed).not.toHaveBeenCalled();
  });
});

describe("snapshot", () => {
  it("hands back copies, so a caller cannot mutate the roster through them", () => {
    join(AUTH, "Jeff", 1);
    const snap = roster.snapshot();
    snap[0].name = "someone else";
    expect(roster.snapshot()[0].name).toBe("Jeff");
  });
});
