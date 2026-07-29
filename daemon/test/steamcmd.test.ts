import { describe, it, expect, beforeEach } from "vitest";
import { SteamCmd } from "../src/steamcmd.js";
import { makeFakeSpawn } from "./fixtures/fake-spawn.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { join } from "node:path";

const cfg = { ...DEFAULT_CONFIG, steamcmdExe: "C:\\Users\\testuser\\steam\\steamcmd.exe" };

let spawn: ReturnType<typeof makeFakeSpawn>;
let steam: SteamCmd;

beforeEach(() => {
  spawn = makeFakeSpawn();
  steam = new SteamCmd(cfg, spawn.spawn);
});

describe("argument construction", () => {
  it("downloads a workshop item anonymously for the workshop app id", () => {
    expect(steam.buildWorkshopArgs("3731244177")).toEqual([
      "+login",
      "anonymous",
      "+workshop_download_item",
      "1169040",
      "3731244177",
      "+quit",
    ]);
  });

  it("puts force_install_dir before login when updating the server app", () => {
    const args = steam.buildUpdateArgs();
    expect(args.indexOf("+force_install_dir")).toBeLessThan(args.indexOf("+login"));
    expect(args).toEqual([
      "+force_install_dir",
      cfg.serverRoot,
      "+login",
      "anonymous",
      "+app_update",
      "1169370",
      "validate",
      "+quit",
    ]);
  });

  it("resolves the workshop content dir next to the steamcmd executable", () => {
    expect(steam.workshopItemDir("3731244177")).toBe(
      join("C:\\Users\\testuser\\steam", "steamapps", "workshop", "content", "1169040", "3731244177"),
    );
  });
});

describe("downloadWorkshopItem", () => {
  it("streams every output line and reports success on exit 0", async () => {
    const seen: string[] = [];
    const p = steam.downloadWorkshopItem("123", (l) => seen.push(l));
    const c = spawn.calls[0].child;
    c.emitLine("Redirecting stderr");
    c.emitLine('Success. Downloaded item 123 to "C:\\..."');
    c.exit(0);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(seen).toContain("Redirecting stderr");
    expect(r.output).toContain("Success. Downloaded item 123");
  });

  it("reports failure with steamcmd's own output on a nonzero exit", async () => {
    const p = steam.downloadWorkshopItem("123", () => {});
    const c = spawn.calls[0].child;
    c.emitLine("ERROR! Download item 123 failed (Failure).");
    c.exit(8);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(8);
    expect(r.output).toContain("ERROR! Download item 123 failed");
  });

  it("rejects with the spawn error when steamcmd is missing", async () => {
    const failing = () => {
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    const s = new SteamCmd(cfg, failing as never);
    await expect(s.downloadWorkshopItem("1", () => {})).rejects.toThrow(
      /steamcmd.exe.*ENOENT/s,
    );
  });

  it("keeps stdout and stderr partial lines separate", async () => {
    const seen: string[] = [];
    const p = steam.downloadWorkshopItem("123", (l) => seen.push(l));
    const c = spawn.calls[0].child;
    c.stdout.emit("data", Buffer.from("Downloading item 123"));
    c.stderr.emit("data", Buffer.from("Redirecting stderr to log\r\n"));
    c.stdout.emit("data", Buffer.from(" complete\r\n"));
    c.exit(0);
    const r = await p;
    expect(seen).toContain("Redirecting stderr to log");
    expect(seen).toContain("Downloading item 123 complete");
    expect(seen).not.toContain("Downloading item 123Redirecting stderr to log");
    expect(r.output).not.toContain("Downloading item 123Redirecting stderr to log");
  });

  it("strips a trailing carriage return from an unterminated final line", async () => {
    const seen: string[] = [];
    const p = steam.downloadWorkshopItem("123", (l) => seen.push(l));
    const c = spawn.calls[0].child;
    c.stdout.emit("data", Buffer.from("Final line\r"));
    c.exit(0);
    const r = await p;
    expect(seen).toContain("Final line");
    expect(r.output).toContain("Final line");
    expect(r.output).not.toContain("Final line\r");
  });

  it("emits the final line even when the process exits with no trailing newline", async () => {
    const seen: string[] = [];
    const p = steam.downloadWorkshopItem("123", (l) => seen.push(l));
    const c = spawn.calls[0].child;
    c.stdout.emit("data", Buffer.from("Success without newline"));
    c.exit(0);
    const r = await p;
    expect(seen).toContain("Success without newline");
    expect(r.output).toContain("Success without newline");
  });
});
