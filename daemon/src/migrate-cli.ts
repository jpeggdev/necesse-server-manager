import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findLegacyState, migrateState, stateDirPopulated } from "./migrate-state.js";
import { stateDir } from "./state-dir.js";

const installDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = stateDir();

const found = await findLegacyState(installDir);
if (found.length === 0) {
  console.log(`Nothing to migrate: ${installDir} holds no pre-move state.`);
  process.exit(0);
}
if (await stateDirPopulated(dir)) {
  console.error(
    `${dir} is not empty. Migration will not merge two sets of state; inspect both and ` +
      `remove the one you do not want before running this again.`,
  );
  process.exit(1);
}

console.log(`Copying ${found.join(", ")}\n  from ${installDir}\n  to   ${dir}`);
const { copied } = await migrateState(installDir, dir);
console.log(
  `Copied and verified: ${copied.join(", ")}\n\n` +
    `The originals in ${installDir} were left alone. Start the daemon, confirm it is healthy, ` +
    `then delete them yourself.`,
);
