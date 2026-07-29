import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_CONFIG, modsDirFor, saveConfig, worldsDirFor } from "./config.js";
import { generateToken, probeConfig, realExists } from "./setup-probe.js";
import { stateDir } from "./state-dir.js";
import type { DaemonConfig } from "./types.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = async (question: string, fallback: string | null): Promise<string> => {
  const suffix = fallback === null || fallback === "" ? "" : ` [${fallback}]`;
  const answer = (await rl.question(`${question}${suffix}\n> `)).trim();
  if (answer.length > 0) return answer;
  if (fallback === null) return "";
  return fallback;
};

const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "0.0.0.0");
  });

const dir = stateDir();
const configFile = join(dir, "config.json");

if (await realExists(configFile)) {
  const overwrite = await ask(`${configFile} already exists. Overwrite it? (yes/no)`, "no");
  if (overwrite.toLowerCase() !== "yes") {
    console.log("Left the existing configuration alone.");
    rl.close();
    process.exit(0);
  }
}

console.log(`\nLooking for a Necesse server on this machine...\n`);

const probed = await probeConfig({
  appData: process.env.APPDATA,
  userProfile: process.env.USERPROFILE,
  pathDirs: (process.env.PATH ?? "").split(delimiter).filter((d) => d.length > 0),
  extraServerRoots: [],
  exists: realExists,
});

const report = (label: string, found: string | null): void => {
  console.log(found === null ? `  ${label}: not found` : `  ${label}: ${found}`);
};
report("Game data directory", probed.dataDir);
report("Server install", probed.serverRoot);
report("Java", probed.javaExe);
report("steamcmd", probed.steamcmdExe);
console.log("");

// Read as the interactive user on purpose. This value is written into
// config.json and handed to the game as -datadir, which is exactly what lets
// the daemon later run as SYSTEM - whose own %APPDATA% is
// C:\Windows\system32\config\systemprofile and holds no worlds at all.
const dataDir = await ask(
  "Where is the game's data directory? (contains saves\\worlds and mods)",
  probed.dataDir,
);
const serverRoot = await ask("Where is the dedicated server installed?", probed.serverRoot);
const serverJar = await ask("Where is Server.jar?", probed.serverJar ?? join(serverRoot, "Server.jar"));
const javaExe = await ask("Which java.exe should run it?", probed.javaExe);
const steamcmdExe = await ask(
  "Where is steamcmd.exe? (needed only for mod installs and server updates - leave blank if you have none)",
  probed.steamcmdExe,
);

const portAnswer = await ask("Which port should the daemon listen on?", String(DEFAULT_CONFIG.port));
const port = Number(portAnswer);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`"${portAnswer}" is not a valid port number.`);
  rl.close();
  process.exit(1);
}
if (!(await portFree(port))) {
  console.warn(
    `Warning: something is already listening on port ${port}. If that is an older copy of ` +
      `this daemon, stop it before starting the new one.`,
  );
}

console.log(
  `\nA Steam Web API key is needed only for workshop search. Everything else - installing a ` +
    `mod by id, updating mods, updating the server - works without one. Get one at ` +
    `https://steamcommunity.com/dev/apikey`,
);
const steamApiKey = await ask("Steam Web API key (leave blank for none)", "");

const authToken = generateToken();

const cfg: DaemonConfig = {
  ...DEFAULT_CONFIG,
  dataDir,
  modsDir: modsDirFor(dataDir),
  worldsDir: worldsDirFor(dataDir),
  serverRoot,
  serverJar,
  javaExe,
  steamcmdExe,
  port,
  steamApiKey,
  authToken,
};

await mkdir(dir, { recursive: true });
// Written through saveConfig so the derived directories are omitted exactly as
// they are for every other write, and so there is one implementation of "what
// config.json looks like".
await saveConfig(configFile, cfg);

console.log(`\nWrote ${configFile}\n`);
console.log(`Your access token is:\n\n    ${authToken}\n`);
console.log(
  `Enter that in the client's connection screen. It is stored in config.json under ` +
    `"authToken" if you need it again.\n\n` +
    `Next: run start-daemon.cmd to run it in this window, or register-task.ps1 (as ` +
    `Administrator) to have it start automatically at boot - that's register-task.ps1 at the ` +
    `root of a release download, or scripts\\03-register-task.ps1 if you are running from a ` +
    `source checkout.`,
);
rl.close();
