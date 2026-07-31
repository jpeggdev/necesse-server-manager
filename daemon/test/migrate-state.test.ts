import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLegacyState,
  legacyStateRefusal,
  migrateState,
  resolveLegacyState,
  stateDirPopulated,
  verifyTree,
} from "../src/migrate-state.js";
import { BOOT_REFUSAL_FILE } from "../src/state-dir.js";

let root: string;
let install: string;
let state: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-migrate-"));
  install = join(root, "install");
  state = join(root, "state");
  await mkdir(install, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("findLegacyState", () => {
  it("is empty for a clean install directory", async () => {
    expect(await findLegacyState(install)).toEqual([]);
  });

  it("finds legacy files and the library directory", async () => {
    await writeFile(join(install, "config.json"), "{}", "utf8");
    await mkdir(join(install, "mod-library"), { recursive: true });
    const found = await findLegacyState(install);
    expect(found).toContain("config.json");
    expect(found).toContain("mod-library");
  });
});

describe("stateDirPopulated", () => {
  it("is false when the directory does not exist", async () => {
    expect(await stateDirPopulated(state)).toBe(false);
  });

  it("is true once a config lives there", async () => {
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "config.json"), "{}", "utf8");
    expect(await stateDirPopulated(state)).toBe(true);
  });

  /**
   * The refusal writes its own log into this directory. If that counted, the
   * second boot after a refusal would find a "populated" state directory,
   * decide the migration had already happened, and start as a fresh install
   * against an empty one - leaving the real mod library behind, which is the
   * single outcome the refusal exists to prevent. migrate.cmd would also then
   * refuse to run, on the grounds that the destination is not empty.
   */
  it("does not count the boot-refusal log the refusal itself writes", async () => {
    await mkdir(state, { recursive: true });
    await writeFile(join(state, BOOT_REFUSAL_FILE), "refused", "utf8");
    expect(await stateDirPopulated(state)).toBe(false);
  });
});

describe("legacyStateRefusal", () => {
  it("names both directories and the command that fixes it", () => {
    const msg = legacyStateRefusal(install, ["config.json"], state);
    expect(msg).toContain(install);
    expect(msg).toContain(state);
    expect(msg).toContain("migrate.cmd");
  });
});

describe("migrateState", () => {
  it("copies files and the library tree into the state directory", async () => {
    await writeFile(join(install, "config.json"), '{"port":8710}', "utf8");
    await mkdir(join(install, "mod-library", "abc"), { recursive: true });
    await writeFile(join(install, "mod-library", "abc", "a.jar"), "JAR", "utf8");

    const r = await migrateState(install, state);

    expect(r.copied).toContain("config.json");
    expect(r.copied).toContain("mod-library");
    expect(await readFile(join(state, "config.json"), "utf8")).toBe('{"port":8710}');
    expect(await readFile(join(state, "mod-library", "abc", "a.jar"), "utf8")).toBe("JAR");
  });

  it("leaves the originals in place, so a failed migration costs disk and not jars", async () => {
    await writeFile(join(install, "config.json"), "{}", "utf8");
    await mkdir(join(install, "mod-library", "abc"), { recursive: true });
    await writeFile(join(install, "mod-library", "abc", "a.jar"), "JAR", "utf8");

    await migrateState(install, state);

    expect((await stat(join(install, "config.json"))).isFile()).toBe(true);
    expect((await stat(join(install, "mod-library", "abc", "a.jar"))).isFile()).toBe(true);
  });

  it("refuses rather than overwriting a file already in the state directory", async () => {
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "config.json"), "EXISTING", "utf8");
    await writeFile(join(install, "config.json"), "INCOMING", "utf8");

    await expect(migrateState(install, state)).rejects.toThrow(/config\.json/);
    expect(await readFile(join(state, "config.json"), "utf8")).toBe("EXISTING");
  });

  it("verifies what it copied by reading it back", async () => {
    await writeFile(join(install, "mods.json"), "[]", "utf8");
    const r = await migrateState(install, state);
    expect(r.copied).toEqual(["mods.json"]);
    expect(await readFile(join(state, "mods.json"), "utf8")).toBe("[]");
  });

  it("copies deep nested directories", async () => {
    await mkdir(join(install, "mod-library", "abc", "nested"), { recursive: true });
    await writeFile(join(install, "mod-library", "abc", "nested", "deep.jar"), "DEEP_JAR", "utf8");

    const r = await migrateState(install, state);

    expect(r.copied).toContain("mod-library");
    expect(await readFile(join(state, "mod-library", "abc", "nested", "deep.jar"), "utf8")).toBe("DEEP_JAR");
  });

  it("refuses to merge when destination mod-library exists with deep nested files", async () => {
    await mkdir(join(install, "mod-library", "abc", "nested"), { recursive: true });
    await writeFile(join(install, "mod-library", "abc", "nested", "deep.jar"), "SOURCE", "utf8");

    await mkdir(join(state, "mod-library", "abc", "nested"), { recursive: true });
    await writeFile(join(state, "mod-library", "abc", "nested", "deep.jar"), "EXISTING", "utf8");

    await expect(migrateState(install, state)).rejects.toThrow(/mod-library/);
    expect(await readFile(join(state, "mod-library", "abc", "nested", "deep.jar"), "utf8")).toBe("EXISTING");
  });

  it("on partial failure, leaves all originals in place and retains successfully-copied files", async () => {
    await mkdir(state, { recursive: true });
    await writeFile(join(install, "config.json"), '{"first":1}', "utf8");
    await writeFile(join(install, "mods.json"), "[]", "utf8");
    await writeFile(join(state, "mods.json"), "EXISTING_MODS", "utf8");

    await expect(migrateState(install, state)).rejects.toThrow(/mods\.json/);

    expect((await stat(join(install, "config.json"))).isFile()).toBe(true);
    expect((await stat(join(install, "mods.json"))).isFile()).toBe(true);
    expect(await readFile(join(state, "config.json"), "utf8")).toBe('{"first":1}');
    expect(await readFile(join(state, "mods.json"), "utf8")).toBe("EXISTING_MODS");
  });
});

/**
 * `resolveLegacyState` is the only place `findLegacyState`, `stateDirPopulated`
 * and `legacyStateRefusal` are composed - `index.ts` cannot be imported to
 * test that composition directly. The dangerous failure here is asymmetric:
 * dropping the "and not already populated" condition means a real legacy
 * install boots silently against an empty state directory rather than
 * refusing, so both directions are pinned, and the refusal message is checked
 * for which directory plays which role rather than merely containing both
 * strings.
 */
describe("resolveLegacyState", () => {
  it("refuses when legacy state is present and the state directory is empty", async () => {
    await writeFile(join(install, "config.json"), "{}", "utf8");

    const message = await resolveLegacyState(install, state);

    expect(message).not.toBeNull();
    expect(message).toContain(`keeps its state in ${state}`);
    expect(message).toContain(`but ${install} still holds`);
  });

  it("returns null when legacy state is present but the state directory is already populated", async () => {
    await writeFile(join(install, "config.json"), "{}", "utf8");
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "config.json"), "{}", "utf8");

    expect(await resolveLegacyState(install, state)).toBeNull();
  });

  it("still refuses on the second boot, when its own refusal log is all that is there", async () => {
    await writeFile(join(install, "config.json"), "{}", "utf8");
    await mkdir(state, { recursive: true });
    await writeFile(join(state, BOOT_REFUSAL_FILE), "refused", "utf8");

    expect(await resolveLegacyState(install, state)).not.toBeNull();
  });
});

describe("verifyTree", () => {
  it("resolves when identical nested trees exist at multiple levels", async () => {
    await mkdir(join(state, "abc", "nested", "deep"), { recursive: true });
    await writeFile(join(state, "abc", "nested", "file1.txt"), "CONTENT_1", "utf8");
    await writeFile(join(state, "abc", "nested", "deep", "file2.txt"), "CONTENT_2", "utf8");

    const from = join(root, "from");
    await mkdir(join(from, "abc", "nested", "deep"), { recursive: true });
    await writeFile(join(from, "abc", "nested", "file1.txt"), "CONTENT_1", "utf8");
    await writeFile(join(from, "abc", "nested", "deep", "file2.txt"), "CONTENT_2", "utf8");

    await expect(verifyTree(from, state)).resolves.toBeUndefined();
  });

  it("throws naming the deep file when bytes mismatch two levels down", async () => {
    await mkdir(join(state, "abc", "nested"), { recursive: true });
    await writeFile(join(state, "abc", "nested", "file.jar"), "WRONG", "utf8");

    const from = join(root, "from");
    await mkdir(join(from, "abc", "nested"), { recursive: true });
    await writeFile(join(from, "abc", "nested", "file.jar"), "CORRECT", "utf8");

    await expect(verifyTree(from, state)).rejects.toThrow(/file\.jar/);
  });

  it("throws when a file exists in source but is missing from destination", async () => {
    await mkdir(join(state, "abc", "nested"), { recursive: true });
    await writeFile(join(state, "abc", "nested", "existing.txt"), "EXISTS", "utf8");

    const from = join(root, "from");
    await mkdir(join(from, "abc", "nested"), { recursive: true });
    await writeFile(join(from, "abc", "nested", "existing.txt"), "EXISTS", "utf8");
    await writeFile(join(from, "abc", "nested", "missing.txt"), "NOT_COPIED", "utf8");

    await expect(verifyTree(from, state)).rejects.toThrow(/missing\.txt/);
  });
});
