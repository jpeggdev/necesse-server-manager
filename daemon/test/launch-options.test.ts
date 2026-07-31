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
    expect(await store.load()).toEqual({ defaults: {}, worlds: {}, updatedAt: null });
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

  it("does not share state between instances over non-existent files", async () => {
    // Pin the invariant: two stores over different files that do not exist
    // must not share their internal defaults or worlds state. This test is
    // independent of test ordering and directly asserts the invariant.
    const root2 = await mkdtemp(join(tmpdir(), "necesse-launch-"));
    const file2 = join(root2, "launch-options.json");
    const store2 = new LaunchOptions(file2);

    try {
      // First store writes a world override.
      await store.setForWorld("Tulsa", { motd: "store1" });

      // Second store over a different, non-existent file must be empty.
      expect(await store2.defaults()).toEqual({});
      expect(await store2.forWorld("Tulsa")).toEqual({});
      expect(await store2.load()).toEqual({ defaults: {}, worlds: {}, updatedAt: null });
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });
});
