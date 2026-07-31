import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaunchOptions } from "../src/launch-options.js";

let root: string;
let file: string;
let store: LaunchOptions;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-launch-"));
  file = join(root, "launch-options.json");
  store = new LaunchOptions(file);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("load", () => {
  it("treats a missing file as empty rather than an error", async () => {
    expect(await store.load()).toEqual({
      defaults: {},
      worlds: {},
      updatedAt: null,
      ownersMigratedAt: null,
    });
  });

  it("reports a parse failure with the path rather than defaulting", async () => {
    await writeFile(file, "{ not json", "utf8");
    await expect(store.load()).rejects.toThrow(file);
  });
});

describe("setDefaults", () => {
  it("stores and reads back", async () => {
    await store.setDefaults({ owner: "Jeff", slots: 5 });
    expect(await store.defaults()).toEqual({ owner: "Jeff", slots: 5 });
  });

  it("merges rather than replacing", async () => {
    await store.setDefaults({ owner: "Jeff" });
    await store.setDefaults({ slots: 5 });
    expect(await store.defaults()).toEqual({ owner: "Jeff", slots: 5 });
  });

  it("clears an option when given null", async () => {
    await store.setDefaults({ owner: "Jeff", slots: 5 });
    await store.setDefaults({ slots: null });
    expect(await store.defaults()).toEqual({ owner: "Jeff" });
  });
});

/*
 * The branch's central invariant: `null` clears an option, and EVERY other
 * value is a stored override. The three values below are the ones a falsy
 * check silently gets wrong - `if (!value) delete` passes every other test in
 * this file, in http.test.ts and in the daemon suite, because nothing else
 * stores a falsy value and then reads it back. Each pair asserts the stored
 * override AND the different result a clear would produce, so neither half can
 * pass on its own.
 */
describe("falsy values are overrides, not clears", () => {
  it("stores false rather than treating it as a clear", async () => {
    await store.setDefaults({ pausewhenempty: true });
    await store.setForWorld("Tulsa", { pausewhenempty: false });
    expect(await store.forWorld("Tulsa")).toEqual({ pausewhenempty: false });
    // A clear would fall through to the default, which is the opposite value.
    expect(await store.effectiveFor("Tulsa")).toEqual({ pausewhenempty: false });
    await store.setForWorld("Tulsa", { pausewhenempty: null });
    expect(await store.forWorld("Tulsa")).toEqual({});
    expect(await store.effectiveFor("Tulsa")).toEqual({ pausewhenempty: true });
  });

  it("stores 0 rather than treating it as a clear", async () => {
    // 0 is a real value for itemslife (0 means dropped items last forever),
    // worldborder, maxsettlements and maxsettlers - not an absent one.
    await store.setDefaults({ itemslife: 30 });
    await store.setForWorld("Tulsa", { itemslife: 0 });
    expect(await store.forWorld("Tulsa")).toEqual({ itemslife: 0 });
    expect(await store.effectiveFor("Tulsa")).toEqual({ itemslife: 0 });
    await store.setForWorld("Tulsa", { itemslife: null });
    expect(await store.effectiveFor("Tulsa")).toEqual({ itemslife: 30 });
  });

  it("stores an empty string rather than treating it as a clear", async () => {
    await store.setDefaults({ motd: "hello" });
    await store.setForWorld("Tulsa", { motd: "" });
    expect(await store.forWorld("Tulsa")).toEqual({ motd: "" });
    expect(await store.effectiveFor("Tulsa")).toEqual({ motd: "" });
    await store.setForWorld("Tulsa", { motd: null });
    expect(await store.effectiveFor("Tulsa")).toEqual({ motd: "hello" });
  });

  it("keeps a falsy override across a reload, not just in the write's return", async () => {
    // The setters return the record they just built, so a store that dropped
    // falsy values only on the way to disk would still pass the tests above.
    await store.setForWorld("Tulsa", { pausewhenempty: false, itemslife: 0, motd: "" });
    const reopened = new LaunchOptions(file);
    expect(await reopened.forWorld("Tulsa")).toEqual({
      pausewhenempty: false,
      itemslife: 0,
      motd: "",
    });
  });
});

describe("setForWorld", () => {
  it("keeps worlds separate", async () => {
    await store.setForWorld("Tulsa", { motd: "tulsa" });
    await store.setForWorld("Goober Goof", { motd: "goober" });
    expect(await store.forWorld("Tulsa")).toEqual({ motd: "tulsa" });
    expect(await store.forWorld("Goober Goof")).toEqual({ motd: "goober" });
  });

  // Windows filenames are case-insensitive and listWorlds reads names off disk,
  // so two casings are one world everywhere else in this daemon.
  it("treats a world name case-insensitively", async () => {
    await store.setForWorld("Tulsa", { motd: "tulsa" });
    expect(await store.forWorld("TULSA")).toEqual({ motd: "tulsa" });
    await store.setForWorld("  tulsa  ", { slots: 3 });
    expect(await store.forWorld("Tulsa")).toEqual({ motd: "tulsa", slots: 3 });
  });

  it("clears a world override when given null, falling back to the default", async () => {
    await store.setDefaults({ slots: 5 });
    await store.setForWorld("Tulsa", { slots: 20 });
    expect(await store.effectiveFor("Tulsa")).toEqual({ slots: 20 });
    await store.setForWorld("Tulsa", { slots: null });
    expect(await store.forWorld("Tulsa")).toEqual({});
    expect(await store.effectiveFor("Tulsa")).toEqual({ slots: 5 });
  });
});

/*
 * `__proto__` is a legal Windows filename, so it is a possible world name, and
 * `normaliseWorld` only lowercases so it survives to the key unchanged. On a
 * plain object `worlds["__proto__"] = {...}` runs Object.prototype's setter
 * and replaces the prototype instead of storing anything, and reading it back
 * returns Object.prototype instead of the caller's record. The save is echoed
 * to the client as succeeded while nothing is written - the silent-success
 * shape this whole feature exists to remove.
 */
describe("a world named __proto__", () => {
  it("stores its overrides and reads them back", async () => {
    await store.setForWorld("__proto__", { motd: "kept" });
    expect(await store.forWorld("__proto__")).toEqual({ motd: "kept" });

    // Reopened, because the in-memory record and the file are two separate
    // claims: a prototype assignment is not serialized by JSON.stringify at
    // all, so only a reload proves the save actually landed on disk.
    const reopened = new LaunchOptions(file);
    expect(await reopened.forWorld("__proto__")).toEqual({ motd: "kept" });
    expect(await reopened.effectiveFor("__proto__")).toEqual({ motd: "kept" });
  });

  it("hands back an empty record before anything is stored, not Object.prototype", async () => {
    // `worlds["__proto__"] ?? {}` on a plain object never reaches the `{}`:
    // the inherited value is Object.prototype itself, which is not nullish, so
    // the route answers with that object. `toEqual({})` cannot see this -
    // Object.prototype has no enumerable own properties - so identity is what
    // this asserts.
    const overrides = await store.forWorld("__proto__");
    expect(overrides).not.toBe(Object.prototype);
    expect(overrides).toEqual({});
  });
});

describe("effectiveFor", () => {
  it("is the defaults for a world with no overrides", async () => {
    await store.setDefaults({ owner: "Jeff" });
    expect(await store.effectiveFor("Anything")).toEqual({ owner: "Jeff" });
  });

  it("lets a world override one option without losing the others", async () => {
    await store.setDefaults({ owner: "Jeff", slots: 5 });
    await store.setForWorld("Tulsa", { owner: "Eli" });
    expect(await store.effectiveFor("Tulsa")).toEqual({ owner: "Eli", slots: 5 });
  });
});

// Both setDefaults and setForWorld do an unserialized-looking load, mutate,
// write of the whole file - so two overlapping calls racing would otherwise
// let the second one's load complete before the first one's write lands,
// silently erasing the first call's change. These pin that the store itself
// serializes, so two writers never need to know about each other.
describe("concurrent writes", () => {
  it("loses neither change when two setDefaults calls overlap", async () => {
    await Promise.all([store.setDefaults({ owner: "Jeff" }), store.setDefaults({ slots: 10 })]);
    expect(await store.defaults()).toEqual({ owner: "Jeff", slots: 10 });
  });

  it("loses neither change when a defaults write and a world write overlap", async () => {
    await Promise.all([
      store.setDefaults({ owner: "Jeff" }),
      store.setForWorld("Tulsa", { slots: 10 }),
    ]);
    expect(await store.defaults()).toEqual({ owner: "Jeff" });
    expect(await store.forWorld("Tulsa")).toEqual({ slots: 10 });
  });
});

describe("persistence", () => {
  it("writes a file a second store can read", async () => {
    await store.setDefaults({ owner: "Jeff" });
    await store.setForWorld("Tulsa", { slots: 9 });
    const reopened = new LaunchOptions(file);
    expect(await reopened.defaults()).toEqual({ owner: "Jeff" });
    expect(await reopened.forWorld("Tulsa")).toEqual({ slots: 9 });
  });

  it("records when it last changed", async () => {
    await store.setDefaults({ owner: "Jeff" });
    const written = JSON.parse(await readFile(file, "utf8")) as { updatedAt: string };
    expect(Date.parse(written.updatedAt)).not.toBeNaN();
  });

  /*
   * The named failure mode: `load()`'s missing-file branch returning a SHARED
   * empty value instead of building a fresh one. Hoisting
   * `{ defaults: {}, worlds: {}, ... }` to a module constant is an obvious
   * tidy-up and it compiles, but every setter mutates whatever `load()` hands
   * back, so the first write against a missing file would scribble on that
   * constant and every other store over a missing file - a different install's
   * state directory, or the next test - would read it back as its own.
   */
  it("does not share state between instances over non-existent files", async () => {
    const root2 = await mkdtemp(join(tmpdir(), "necesse-launch-"));
    const store2 = new LaunchOptions(join(root2, "launch-options.json"));

    try {
      await store.setDefaults({ owner: "Jeff" });
      await store.setForWorld("Tulsa", { motd: "store1" });

      expect(await store2.defaults()).toEqual({});
      expect(await store2.forWorld("Tulsa")).toEqual({});
      expect(await store2.load()).toEqual({
        defaults: {},
        worlds: {},
        updatedAt: null,
        ownersMigratedAt: null,
      });

      // The two loads must not even be the same objects: a shared constant
      // that nothing had mutated yet would still pass every assertion above,
      // and would break on the first write after this test.
      const a = await store2.load();
      const b = await store2.load();
      expect(a).not.toBe(b);
      expect(a.worlds).not.toBe(b.worlds);
      expect(a.defaults).not.toBe(b.defaults);
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });
});

/*
 * The re-run guard for the config.json `owners` migration. It used to be "a
 * default owner exists", which is a fact about current state: clearing the
 * owner on purpose re-seeded it from the stale array at the next boot, because
 * `owners` is never removed from config.json. The marker is durable instead.
 */
describe("owners migration marker", () => {
  it("is absent until something records it", async () => {
    expect(await store.ownersMigrated()).toBe(false);
    await store.setDefaults({ owner: "Jeff" });
    expect(await store.ownersMigrated()).toBe(false);
  });

  it("survives a reload and is not disturbed by later writes", async () => {
    await store.markOwnersMigrated();
    expect(await store.ownersMigrated()).toBe(true);

    await store.setDefaults({ owner: "Jeff" });
    await store.setForWorld("Tulsa", { slots: 5 });
    const reopened = new LaunchOptions(file);
    expect(await reopened.ownersMigrated()).toBe(true);
    expect(await reopened.defaults()).toEqual({ owner: "Jeff" });
  });

  it("keeps the first timestamp when marked again", async () => {
    await store.markOwnersMigrated();
    const first = (await store.load()).ownersMigratedAt;
    expect(Date.parse(first as string)).not.toBeNaN();
    await store.markOwnersMigrated();
    expect((await store.load()).ownersMigratedAt).toBe(first);
  });
});
