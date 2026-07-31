import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchOptions } from "../src/launch-options.js";
import { migrateOwners } from "../src/launch-options-migration.js";

let root: string;
let store: LaunchOptions;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-ownermig-"));
  store = new LaunchOptions(join(root, "launch-options.json"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("migrateOwners", () => {
  it("seeds the default owner from the FIRST entry", async () => {
    // The game keeps the LAST -owner, so this server has been applying Eli.
    // Seeding the first is a deliberate behaviour change: it is the fix this
    // feature exists to deliver, chosen rather than inherited.
    const msg = await migrateOwners(["Jeff", "Eli"], store);
    expect(await store.defaults()).toEqual({ owner: "Jeff" });
    expect(msg).toContain("Jeff");
    expect(msg).toContain("Eli");
  });

  it("creates no per-world overrides", async () => {
    await migrateOwners(["Jeff", "Eli"], store);
    expect(await store.forWorld("Tulsa")).toEqual({});
  });

  it("does nothing when a default owner is already set", async () => {
    await store.setDefaults({ owner: "Someone" });
    expect(await migrateOwners(["Jeff"], store)).toBeNull();
    expect(await store.defaults()).toEqual({ owner: "Someone" });
  });

  it("does nothing for an absent or empty list", async () => {
    expect(await migrateOwners(undefined, store)).toBeNull();
    expect(await migrateOwners([], store)).toBeNull();
    expect(await store.defaults()).toEqual({});
  });

  it("ignores a stored value that is not a list of names", async () => {
    expect(await migrateOwners("Jeff", store)).toBeNull();
    expect(await migrateOwners([1, 2], store)).toBeNull();
    expect(await store.defaults()).toEqual({});
  });

  it("says nothing about a collapse when there was only one owner", async () => {
    const msg = await migrateOwners(["Jeff"], store);
    expect(await store.defaults()).toEqual({ owner: "Jeff" });
    expect(msg).not.toMatch(/only the last/i);
  });
});
