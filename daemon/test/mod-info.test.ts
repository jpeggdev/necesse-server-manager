import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NotAModJarError,
  checkJarFilename,
  parseModInfo,
  readModInfo,
  safeModId,
} from "../src/mod-info.js";
import {
  MOD_INFO_SUMMONER_EXPANSION,
  makeModJar,
  makeNonModJar,
  modInfoText,
} from "./fixtures/mod-jar.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "necesse-modinfo-"));
});

describe("reading mod.info out of a real jar", () => {
  it("parses the verbatim mod.info from the jar this feature was written for", async () => {
    // Not a hand-written approximation: this is the exact text extracted from
    // SummonerExpansion-1.2.0-7.7.jar, the hand-placed jar in the live server's
    // mods folder.
    const path = await makeModJar(root, "SummonerExpansion-1.2.0-7.7.jar", {}, {
      info: MOD_INFO_SUMMONER_EXPANSION,
    });

    expect(await readModInfo(path)).toEqual({
      id: "gagadoliano.summonerexpansion",
      name: "Summoner Expansion",
      version: "7.7",
      gameVersion: "1.2.0",
      author: "Gagadoliano",
      clientside: false,
    });
  });

  it("reads a clientside mod as clientside", async () => {
    const path = await makeModJar(root, "Client.jar", {
      id: "someone.clientonly",
      name: "Client Only",
      version: "1.0",
      clientside: true,
    });
    expect((await readModInfo(path)).clientside).toBe(true);
  });

  it("rejects a jar with no mod.info as not a Necesse mod, naming the file", async () => {
    const path = await makeNonModJar(root, "SomeLibrary.jar");
    await expect(readModInfo(path)).rejects.toThrow(NotAModJarError);
    await expect(readModInfo(path)).rejects.toThrow(/no mod\.info at its root/);
    await expect(readModInfo(path)).rejects.toThrow(/SomeLibrary\.jar/);
  });

  it("rejects a mod.info with no id: there is no identity to file it under", async () => {
    const path = await makeModJar(root, "Nameless.jar", {
      name: "Has A Name But No Id",
      version: "1.0",
    });
    await expect(readModInfo(path)).rejects.toThrow(/no "id" line/);
  });

  it("rejects a file that is not a zip at all", async () => {
    const path = join(root, "NotAZip.jar");
    await writeFile(path, "this is just text");
    await expect(readModInfo(path)).rejects.toThrow(NotAModJarError);
    await expect(readModInfo(path)).rejects.toThrow(/not a readable jar/);
  });

  // ENOENT is the one failure a caller has to be able to tell apart: "that jar
  // is gone" is a different situation from "that jar is not a mod".
  it("lets a missing file surface as ENOENT rather than as 'not a mod'", async () => {
    await expect(readModInfo(join(root, "nope.jar"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("parseModInfo", () => {
  it("falls back to the id when the file gives no name", () => {
    const info = parseModInfo(modInfoText({ id: "a.b", version: "1.0" }), "x.jar");
    expect(info.name).toBe("a.b");
  });

  it("reports missing descriptive fields as empty, never as undefined", () => {
    const info = parseModInfo(modInfoText({ id: "a.b" }), "x.jar");
    expect(info).toEqual({
      id: "a.b",
      name: "a.b",
      version: "",
      gameVersion: "",
      author: "",
      clientside: false,
    });
  });

  it("refuses text that is not a mod.info block", () => {
    expect(() => parseModInfo("id = a.b\n", "x.jar")).toThrow(NotAModJarError);
  });

  // The same parser reads worldSettings.cfg, whose format allows both.
  it("copes with the format's trailing commas and `//` comments", () => {
    const text = ["{", "\tid = a.b, // the id", "\tversion = 2.0,", "\tname = A B", "}"].join("\n");
    expect(parseModInfo(text, "x.jar")).toMatchObject({ id: "a.b", version: "2.0", name: "A B" });
  });
});

describe("safeModId", () => {
  it("leaves a real mod id exactly as it is, so the library stays browsable", () => {
    expect(safeModId("gagadoliano.summonerexpansion")).toBe("gagadoliano.summonerexpansion");
    expect(safeModId("aphoreateam.aphoreamod")).toBe("aphoreateam.aphoreamod");
  });

  it("never lets an id address anything outside its own folder", () => {
    for (const id of ["../../evil", "a/b", "a\\b", "C:evil", ".", "..", "con", ""]) {
      const safe = safeModId(id);
      expect(safe, id).not.toMatch(/[\\/:]/);
      expect(safe, id).not.toContain("..");
      expect(safe.length, id).toBeGreaterThan(0);
    }
  });

  // Two different ids landing in one folder would let one mod's jar overwrite
  // another's, which is exactly the collision the per-id folder exists to stop.
  it("stays injective: ids that differ only in case or in punctuation do not collide", () => {
    const ids = ["Some.Mod", "some.mod", "some/mod", "some\\mod", "some:mod", "some mod"];
    const safe = ids.map(safeModId);
    expect(new Set(safe).size).toBe(ids.length);
  });
});

describe("checkJarFilename", () => {
  it("accepts an ordinary jar name", () => {
    expect(() => checkJarFilename("SummonerExpansion-1.2.0-7.7.jar")).not.toThrow();
  });

  // A filename crosses the API from an unauthenticated LAN client. `basename`
  // alone would silently rewrite a traversal into a plausible name instead of
  // refusing it, which is how a jar ends up somewhere nobody asked for.
  it("refuses anything that is a path rather than a filename", () => {
    for (const name of ["../evil.jar", "..\\evil.jar", "a/b.jar", "a\\b.jar", "C:evil.jar"]) {
      expect(() => checkJarFilename(name), name).toThrow(NotAModJarError);
    }
  });

  it("refuses a name that is not a jar, and an empty one", () => {
    expect(() => checkJarFilename("mod.zip")).toThrow(/does not end in \.jar/);
    expect(() => checkJarFilename("   ")).toThrow(/may not be empty/);
    expect(() => checkJarFilename(`${"a".repeat(300)}.jar`)).toThrow(/too long/);
  });
});
