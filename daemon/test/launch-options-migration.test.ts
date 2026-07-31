import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchOptions } from "../src/launch-options.js";
import { migrateOwners, runOwnerMigration } from "../src/launch-options-migration.js";

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

  it("seeds the default and creates no per-world overrides", async () => {
    // Asserted together: a no-op migration would also leave forWorld empty,
    // so that alone can't tell a real migration from an absent one. Pairing
    // it with the seeded default is what makes this fail when the migration
    // doesn't run at all.
    await migrateOwners(["Jeff", "Eli"], store);
    const file = await store.load();
    expect(file.defaults).toEqual({ owner: "Jeff" });
    expect(file.worlds).toEqual({});
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

describe("runOwnerMigration", () => {
  const configFile = () => join(root, "config.json");

  it("reports success through the same outcome shape a failure uses", async () => {
    await writeFile(configFile(), JSON.stringify({ owners: ["Jeff", "Eli"] }), "utf8");
    const outcome = await runOwnerMigration(configFile(), store);
    expect(outcome.failed).toBe(false);
    expect(outcome.message).toContain("Jeff");
    expect(await store.defaults()).toEqual({ owner: "Jeff" });
  });

  // Pins the fix: a failed migration must reach configWarnings exactly like a
  // successful one does, phrased so an operator can tell the two apart. Not
  // console-only - stdout is discarded under the Scheduled Task this daemon
  // runs as, which is the whole reason console.error alone was not enough.
  it("turns a migration failure into a non-null, distinctly-worded outcome", async () => {
    // No config.json written: readStoredConfig throws exactly as it would on
    // a real race (the file vanishing between resolveBootConfig and here) or
    // a corrupt file - readStoredConfig's own message names the missing file.
    const outcome = await runOwnerMigration(configFile(), store);
    expect(outcome.failed).toBe(true);
    expect(outcome.message).not.toBeNull();
    // The underlying error is carried verbatim, not paraphrased.
    expect(outcome.message).toContain(configFile());
    expect(outcome.message).toContain("No config.json");
    // Distinguishable from what a successful migration says.
    expect(outcome.message).toMatch(/failed/i);
    expect(outcome.message).not.toContain("Moved the configured owner");
  });
});
