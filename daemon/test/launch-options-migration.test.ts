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

  // The migration source is config.json's `owners`, which loadConfig and
  // saveConfig round-trip forever: it is still there at every later boot, so
  // the guard has to be about history, not about what is set right now.
  it("does not re-seed an owner the operator deliberately cleared", async () => {
    await migrateOwners(["Jeff", "Eli"], store);
    expect(await store.defaults()).toEqual({ owner: "Jeff" });

    // The operator clears it from the client, then the daemon restarts.
    await store.setDefaults({ owner: null });
    expect(await migrateOwners(["Jeff", "Eli"], store)).toBeNull();
    expect(await store.defaults()).toEqual({});

    // And again, because "runs once" has to hold for every later boot too.
    expect(await migrateOwners(["Jeff", "Eli"], store)).toBeNull();
    expect(await store.defaults()).toEqual({});
  });

  it("records that it ran, durably", async () => {
    await migrateOwners(["Jeff"], store);
    expect(await store.ownersMigrated()).toBe(true);
  });

  // The upgrade path for an install that migrated before the marker existed,
  // or whose operator had already chosen an owner: it must be recorded as
  // migrated, or clearing the owner would still re-seed it one boot later.
  it("records an install that already has an owner as migrated, without touching it", async () => {
    await store.setDefaults({ owner: "Someone" });
    expect(await migrateOwners(["Jeff"], store)).toBeNull();
    expect(await store.defaults()).toEqual({ owner: "Someone" });
    expect(await store.ownersMigrated()).toBe(true);

    await store.setDefaults({ owner: null });
    expect(await migrateOwners(["Jeff"], store)).toBeNull();
    expect(await store.defaults()).toEqual({});
  });

  it("stores the owner name trimmed, not as written", async () => {
    // The filter already tests `trim()`, so an entry padded with whitespace
    // passed it and was stored with the padding, which then reaches the game's
    // command line as part of the name.
    const msg = await migrateOwners(["  Jeff  "], store);
    expect(await store.defaults()).toEqual({ owner: "Jeff" });
    expect(msg).toContain('"Jeff"');
  });

  /*
   * The one path into the store that does not go through an HTTP route. The
   * game joins its whole command line into one string before parsing it, so an
   * owner name carrying a word that starts with `-` empties `-owner` and sets
   * a real option instead. config.json is hand-edited on the server box, so
   * this is boundary input, and the migration has to apply the same check the
   * routes do or it becomes the way that value reaches the command line.
   */
  it("refuses an owner name the game would re-parse as a flag, and seeds nothing", async () => {
    const msg = await migrateOwners(["Jeff -settings C:/evil.cfg", "Eli"], store);
    expect(await store.defaults()).toEqual({});
    expect(msg).not.toBeNull();
    // Names the value, so the operator knows which entry to fix...
    expect(msg).toContain("-settings C:/evil.cfg");
    // ...carries the checker's own reason rather than a paraphrase...
    expect(msg).toMatch(/starts a new option/i);
    // ...and says what the server does in the meantime.
    expect(msg).toMatch(/without -owner/);
  });

  it("leaves a refused migration pending rather than recording it as done", async () => {
    // It did not happen, so it must not be marked. The warning then repeats
    // every boot until the operator fixes it - and setting a valid owner from
    // the client trips the "already has an owner" branch, which marks it and
    // stops the warning.
    await migrateOwners(["-dev"], store);
    expect(await store.ownersMigrated()).toBe(false);

    await store.setDefaults({ owner: "Jeff" });
    expect(await migrateOwners(["-dev"], store)).toBeNull();
    expect(await store.ownersMigrated()).toBe(true);
  });

  it("refuses a hyphenated owner name, which the real parser splits into two options", async () => {
    // Previously asserted here as SAFE, on the belief that only a word STARTING
    // with `-` was a problem. Probed against C:\necesseserver\Server.jar:
    // `-owner Jean-Luc` sets owner=Jean-Luc AND an option called `Luc`, because
    // the parser resyncs on a hyphen anywhere. Inverted rather than deleted so
    // the hole cannot be reintroduced through this path.
    const msg = await migrateOwners(["Jean-Luc"], store);
    expect(await store.defaults()).toEqual({});
    expect(msg).toContain("Jean-Luc");
    expect(await store.ownersMigrated()).toBe(false);
  });

  it("still migrates an ordinary name, so the check is not simply refusing everything", async () => {
    // The paired positive control. Underscore, not hyphen - probed intact.
    const msg = await migrateOwners(["Jean_Luc"], store);
    expect(await store.defaults()).toEqual({ owner: "Jean_Luc" });
    expect(msg).toContain("Jean_Luc");
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

  // The refusal has to survive the boot wrapper to be worth anything: index.ts
  // pushes `message` onto configWarnings, which rides on StatusPayload and so
  // reaches the operator through GET /api/status and the websocket "status"
  // broadcast. A refusal that only existed inside migrateOwners would leave the
  // operator with no owner and no reason, on a daemon whose stdout goes nowhere.
  it("carries a refused owner name out to the boot outcome, without failing the boot", async () => {
    await writeFile(configFile(), JSON.stringify({ owners: ["-dev"] }), "utf8");
    const outcome = await runOwnerMigration(configFile(), store);
    expect(outcome.message).not.toBeNull();
    expect(outcome.message).toContain("-dev");
    // Not `failed`: the migration ran fine and declined a value, which is a
    // different thing from being unable to read config.json at all.
    expect(outcome.failed).toBe(false);
    expect(await store.defaults()).toEqual({});
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
