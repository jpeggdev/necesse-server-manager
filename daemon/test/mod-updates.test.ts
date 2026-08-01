import { describe, expect, it } from "vitest";
import { workshopEntryUnchanged } from "../src/mod-updates.js";

const AT = "2026-07-20T10:00:00.000Z";

describe("workshopEntryUnchanged", () => {
  it("is true only when the stored timestamp is exactly what Steam reports now", () => {
    expect(workshopEntryUnchanged(AT, { updatedAt: AT })).toBe(true);
  });

  it("is false when Steam has no entry for the mod", () => {
    expect(workshopEntryUnchanged(AT, undefined)).toBe(false);
  });

  it("is false when Steam's entry carries no timestamp", () => {
    expect(workshopEntryUnchanged(AT, { updatedAt: null })).toBe(false);
  });

  it("is false when nothing was ever recorded for the installed jar", () => {
    expect(workshopEntryUnchanged(null, { updatedAt: AT })).toBe(false);
  });

  it("is false when the entry moved forward", () => {
    expect(workshopEntryUnchanged(AT, { updatedAt: "2026-07-21T10:00:00.000Z" })).toBe(false);
  });

  // Equality, not `>`: any movement means the entry is not the one we
  // installed. A `>` test would skip a timestamp that moved backwards in
  // silence, and Steam moving one backwards is exactly the case where we most
  // want to refetch.
  it("is false when the entry moved backwards", () => {
    expect(workshopEntryUnchanged(AT, { updatedAt: "2026-07-19T10:00:00.000Z" })).toBe(false);
  });
});
