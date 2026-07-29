import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_CONFIG, configProblems, modsDirFor, saveConfig, worldsDirFor } from "./config.js";
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

/**
 * Asks for a path and checks it before accepting the answer.
 *
 * The probe only knows two hardcoded server roots, so on a Steam-library
 * install it finds nothing and every default is blank. Pressing Enter through
 * the wizard then produced a config.json with five empty paths, a printed
 * token and "Next: run start-daemon.cmd" - and a daemon that refused to boot
 * with five fatal problems. A typo did the same thing. Nothing in that
 * sequence looked like a failure until the daemon would not start.
 *
 * The miss is reported and re-asked, never silently corrected and never
 * refused outright: an operator setting this up before the game is installed,
 * or on a path that will exist later, still has to be able to say so.
 */
const askPath = async (
  question: string,
  fallback: string | null,
  { optional = false }: { optional?: boolean } = {},
): Promise<string> => {
  for (;;) {
    const answer = await ask(question, fallback);
    if (answer.length === 0) {
      if (optional) return "";
      console.log(`  Nothing entered. The daemon refuses to start until this is set.`);
      const blank = await ask("  Leave it blank and edit config.json by hand later? (yes/no)", "no");
      if (blank.toLowerCase() === "yes") return "";
      continue;
    }
    if (await realExists(answer)) {
      console.log(`  OK: ${answer}`);
      return answer;
    }
    console.log(`  "${answer}" does not exist on this machine.`);
    const keep = await ask("  Use it anyway? (yes/no)", "no");
    if (keep.toLowerCase() === "yes") return answer;
  }
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
const dataDir = await askPath(
  "Where is the game's data directory? (contains saves\\worlds and mods)",
  probed.dataDir,
);
const serverRoot = await askPath("Where is the dedicated server installed?", probed.serverRoot);
const serverJar = await askPath(
  "Where is Server.jar?",
  probed.serverJar ?? (serverRoot === "" ? null : join(serverRoot, "Server.jar")),
);
const javaExe = await askPath("Which java.exe should run it?", probed.javaExe);
// The one path the daemon boots without: nothing but mod installs and server
// updates touches steamcmd, so blank is a supported answer rather than a miss.
const steamcmdExe = await askPath(
  "Where is steamcmd.exe? (needed only for mod installs and server updates - leave blank if you have none)",
  probed.steamcmdExe,
  { optional: true },
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
    `"authToken" if you need it again.\n`,
);

// The same check the daemon runs at every boot, run here where the answers can
// still be corrected. Written from the validator rather than re-derived, so
// the wizard can never call a configuration usable that the daemon will then
// refuse - which is precisely what it used to do.
const problems = await configProblems(cfg, {});
if (problems.length > 0) {
  console.warn(`Setup finished, but this configuration is not usable as it stands:\n`);
  for (const p of problems) console.warn(`  - ${p.message}`);
  console.warn(
    `\nFatal problems stop the daemon from starting at all. Fix them by editing ` +
      `${configFile} (with the daemon stopped) or by running setup.cmd again.`,
  );
} else {
  console.log(
    `Next: run start-daemon.cmd to run it in this window, or register-task.ps1 (as ` +
      `Administrator) to have it start automatically at boot - that's register-task.ps1 at the ` +
      `root of a release download, or scripts\\03-register-task.ps1 if you are running from a ` +
      `source checkout.`,
  );
}
rl.close();
