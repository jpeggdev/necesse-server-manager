import { describe, it, expect } from "vitest";
import { findOrphanServer } from "../src/orphan.js";

const jar = "C:\\necesseserver\\Server.jar";

describe("findOrphanServer", () => {
  it("finds a java process running the configured Server.jar", async () => {
    const list = async () => [
      { pid: 100, commandLine: "C:\\other\\java.exe -jar Other.jar" },
      { pid: 200, commandLine: `C:\\necesseserver\\jre\\bin\\java.exe -jar ${jar} -nogui` },
    ];
    expect((await findOrphanServer(list, jar))?.pid).toBe(200);
  });

  it("matches case-insensitively, as Windows paths are", async () => {
    const list = async () => [{ pid: 7, commandLine: "java.exe -jar c:\\NECESSESERVER\\server.JAR" }];
    expect((await findOrphanServer(list, jar))?.pid).toBe(7);
  });

  it("returns null when no matching process exists", async () => {
    const list = async () => [{ pid: 1, commandLine: "notepad.exe" }];
    expect(await findOrphanServer(list, jar)).toBeNull();
  });

  it("returns null when process enumeration fails rather than throwing", async () => {
    const list = async () => {
      throw new Error("wmi unavailable");
    };
    expect(await findOrphanServer(list, jar)).toBeNull();
  });
});
