# CLAUDE.md

Necesse dedicated-server manager: a Node/TypeScript **daemon** that runs on the
game-server box, and a **Tauri 2 + React client** that drives it over the LAN.

Machine-specific values (SSH target, verified-live notes, local paths) live in
the gitignored `CLAUDE.local.md`, not here.

## Layout and commands

| | |
|---|---|
| `daemon/` | Owns the game-server process and every side effect. Runs on SERVER. |
| `client/` | Thin view over the daemon's HTTP + WebSocket API. Runs on the workstation. |
| `scripts/` | `01-install-node` and `03-register-task` run **on SERVER**; `02-deploy` and `04-restart-daemon` run on the workstation. |

Verify from inside `daemon/` or `client/`: `npx vitest run` and `npx tsc --noEmit`.
Run the two packages separately; there is no workspace root.

## Deploying — read before you touch SERVER

**The game server is a child process of the daemon.** Restarting the daemon can
kill a live game session. Before `02-deploy.ps1` or `04-restart-daemon.ps1`,
confirm nobody is playing — `GET /api/status` reporting `stopped` is the check.

**A box can hold two installs, and deploying to the wrong one reports total
success.** A zip/source deploy under a user profile and an Inno install under
`C:\Program Files\Necesse Server Manager` can both be present; only the one
the Scheduled Task names is running. Copying into the other one succeeds at
every step — files land, `npm ci` succeeds, `04-restart-daemon.ps1` restarts
the task, and its health check passes, because a daemon *is* answering the
port. Just the old one. The only symptom is that the new behaviour is missing,
which looks exactly like having built it wrong. So `02-deploy.ps1` now reads
the task's own action directory first and refuses when it disagrees with
`$InstallDir`, before it builds or copies anything; a missing task is treated
as a first deploy and allowed. An install under Program Files belongs to the
installer and an `scp` as the remote user cannot write there — upgrade that
one by running the installer, not by repointing `deploy.local.ps1`.

`02-deploy.ps1` copies `dist/`, `package.json`, `package-lock.json`, the four
launchers (`setup.cmd`, `start-daemon.cmd`, `migrate.cmd`, `register-task.cmd`
— the boot refusals name the first three, and the setup wizard's closing
message names the fourth, so an install missing any of them tells the
operator to run a file that is not there) and `scripts/03-register-task.ps1`
itself, renamed to `register-task.ps1` (see below), and seeds nothing.
**Daemon state lives in `%PROGRAMDATA%\NecesseServerManager`,
not beside `dist/`** (overridable with the `NECESSE_MANAGER_DATA` environment
variable). That includes `config.json`, `mods.json`, `mod-library/`,
`mod-library.json` and `mod-sets.json` (see `docs/mod-sets-design.md`); the
library is the only copy of every uploaded and hand-placed jar, and the sets
are what each world loads. Because none of that lives in the install
directory, the install directory holds nothing irreplaceable — **"delete the
folder and unzip the new release" is the correct upgrade, not a dangerous
one.** Deploy must never write into it: `mods.json` in particular is one of
`LEGACY_STATE_FILES`, so a copy sitting beside `dist/` makes a fresh install
look like a pre-migration one and refuse to boot demanding `migrate.cmd`, on a
box that was never migrated from anything. `ModRegistry.load()` treats a
missing `mods.json` as zero mods, not an error, so there is nothing to seed —
the file is created on first mod install. An install whose state genuinely is
still sitting beside `dist/` (from before this split existed) refuses to boot
and names `migrate.cmd`, which copies the old files across rather than moving
them, so the originals stay in place until you delete them.

**Every boot refusal is also written to `boot-refusal.txt` in the state
directory** and deleted again on a successful start. The daemon runs as a
Scheduled Task, whose stdout goes nowhere, so without that file the only
symptom of any refusal is `04-restart-daemon.ps1` saying the task did not reach
Running — which is why that script now also runs the daemon once in the
foreground and echoes what it printed. `stateDirPopulated` deliberately ignores
`boot-refusal.txt`: the legacy-state refusal writes it into a directory it has
just called empty, and counting it would make the next boot decide the
migration had already happened.

`config.json` is written by the setup wizard (`npm run setup` in `daemon/`,
or `node dist/setup-cli.js` against a built install) and lives in that state
directory. Hand-edit it with the daemon stopped. **Write it without a BOM** —
PowerShell 5.1's `Set-Content -Encoding UTF8` adds one; use
`[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`.
`loadConfig` tolerates a BOM now, but nothing else does.

**`03-register-task.ps1` is shipped by `02-deploy.ps1`**, renamed to
`register-task.ps1` at the install root — the same rename
`installer/stage-daemon.ps1` does for the zip and installer artifacts, so all
three deploy paths agree on the name `daemon/register-task.cmd` invokes and
the setup wizard's closing message prints. (It used to have to already be on
SERVER for `daemon/register-task.cmd` to find it; a source-checkout deploy
that predates this shipped a `.cmd` that self-elevated, prompted for UAC, and
then died on the missing file.) It reads `deploy.local.ps1` from its own
directory the same way `02-deploy.ps1` does on the workstation, but falls back
if that file is absent: the install directory defaults to wherever the script
itself is sitting (so an operator who places it inside the install directory,
e.g. a release download's `register-task.ps1` at the release root, needs no
extra setup), and `$DaemonPort`/`$TaskName` fall back to `8710`/`NecesseDaemon`.
If you do use a `deploy.local.ps1` on SERVER, **its `$TaskName` must be the
same string `02-deploy.ps1`'s `deploy.local.ps1` will later assume this task
is called** (`04-restart-daemon.ps1` looks it up by that name too) — a
mismatch means the stop-before-re-register check silently finds no existing
task, registers a second one, and the new daemon dies on a port already held
by the old one while the health check at the end still talks to that old one.

**The remote default shell is cmd.exe.** Do not fight nested quoting — `scp` a
`.ps1` over and run it with `powershell -NoProfile -ExecutionPolicy Bypass -File`.
Inline `powershell -Command "..."` through ssh gets pipe-split by the remote
cmd.exe before powershell ever sees it.

**The daemon ships as two release artifacts:** a zip (unchanged, needs Node
22+ already on the box) and `installer/necesse-daemon.iss`, an Inno Setup
installer that bundles its own Node. `installer/fetch-node.ps1` downloads and
SHA-256-verifies it into the staged payload at `node\node.exe`; `daemon/setup.cmd`,
`daemon/start-daemon.cmd`, `daemon/migrate.cmd` and `scripts/03-register-task.ps1`
(shipped as `register-task.ps1`, see below) all prefer `<install dir>\node\node.exe`
over whatever `node.exe` is on `PATH` when it exists, and fall back to `PATH`
otherwise, which is what lets the zip and the installer share one set of
shims. `daemon/register-task.cmd` ships alongside them and is what the Start
Menu shortcut points at: it self-elevates before running `register-task.ps1`,
because the SYSTEM-principal scheduled task and the firewall rule both need
admin and an unelevated run failed the second one *silently*.

The pinned Node version lives in `installer/node-version.txt` (currently
`22.23.2`); that file is the one place to change it. **Part of the release
checklist: check `node-version.txt` against the latest 22.x** at
`https://nodejs.org/dist/index.json` and bump it if it has moved. The bundled
runtime is private to the install, so a user cannot patch it themselves: a
stale pin is a Node CVE nobody on the other end can do anything about. Nothing
enforces this automatically; `installer/verify-installer.ps1` only checks that
the *staged* runtime matches whatever the file says.

## Access token

Every HTTP route and the WebSocket upgrade require an access token, sent as an
`Authorization: Bearer` header (HTTP) or `?token=` (WebSocket, which cannot set
headers on the handshake). The token lives in `config.json`'s `authToken`.
**An empty `authToken` disables the check** — this is the documented
trusted-LAN opt-out, and it is also the upgrade path for a `config.json`
written before this feature existed: it keeps answering requests instead of
locking itself out.

## Who the daemon runs as, and why the data directory is explicit

The task is registered **AtStartup as SYSTEM** (`03-register-task.ps1`), with a
30-second trigger delay so the daemon is not binding its port before the
network stack is up. It used to be **AtLogOn** as whichever account was
logged in, which meant an unattended reboot brought the box up with no daemon
and no server. Autologon is not a general fix: a Microsoft account
(`PrincipalSource=MicrosoftAccount`) gets pushed by Windows to Hello/PIN, and a
stored password is exactly what this arrangement avoids.

SYSTEM was previously impossible because **the game derives its saves and mods
from the running account's `APPDATA`**. As SYSTEM that is
`C:\Windows\system32\config\systemprofile\AppData\Roaming\Necesse`, so the
server would have started with zero worlds and zero mods and reported a
completely successful launch. `Server.jar`'s own help documents `-datadir
<path>`, so `buildArgs` now passes it from `config.json`'s **`dataDir`** and
the game's data directory no longer depends on who launched it. `-datadir`
sits ahead of `-world`: the world is a save inside that directory.

**`dataDir` is the single source of truth.** `modsDir` (`<dataDir>\mods`) and
`worldsDir` (`<dataDir>\saves\worlds`) are derived from it, not stored — a
`config.json` written by an older version that still carries them is not
silently corrected. `configProblems` in `config.ts` compares the stored keys
against what `dataDir` derives and, via `fatalProblems`, **refuses to boot**
rather than pick a winner if they disagree. `resolveBootConfig` runs this
check in `index.ts` before anything reads a folder or spawns anything. Change
`dataDir` and `modsDir`/`worldsDir` follow automatically.

**`modLibraryDir`, `modLibraryFile` and `modSetsFile` derive from the state
directory the same way**, and for a reason worth remembering: they used to be
evaluated at module load and written by `saveConfig` (which runs on every world
start), so every install predating the state directory has install-directory
values for all three stored in its `config.json`. `migrateState` copies those
files across but rewrites no config keys, so a stored value winning would mean
a daemon reading its mod library out of the very directory the upgrade tells
you to delete — and `ModLibrary.load()` reports the resulting missing manifest
as an *empty library*, not an error, so nothing would say the jars were gone.
A stored value is ignored and dropped by the next write. `DEFAULT_CONFIG`
carries `""` for all five derived paths; resolving them at module load would
call `stateFile()` on import, which throws wherever `PROGRAMDATA` is unset.

## Constraints that bite

- **Daemon sources must stay ES2020-library-compatible.** `client/test/api.integration.test.ts`
  imports the real daemon, so every daemon file is typechecked a second time
  under the client's ES2020 lib. `daemon/tsconfig.json` pins `"lib": ["ES2020"]`
  so an ES2022 call (`Object.hasOwn`, `Array.at`, `findLast`) fails where you
  are editing rather than in the other package. Do not raise it to silence an
  error.
- **`daemon/src/types.ts` and `client/src/types.ts` must stay byte-identical.**
  Two separately deployed apps, duplicated on purpose rather than sharing a
  workspace package. Hash both after editing either.
- **Errors are never swallowed or reworded.** A missing file (`ENOENT`) is
  distinguished from a real failure; everything else rethrows with the path and
  the underlying message. Several modules were fixed to comply — a `catch` that
  returns a default is a defect here, not a convenience.
- **Mod mutations and server updates are refused while the server runs or a
  task is in flight**, and nothing stops the server as a side effect. The game
  reads its mod set only at startup.
- **`stop` never escalates to a kill on timeout.** The server saves the world
  during shutdown; killing it risks the save. `kill` is a separate endpoint so
  it can never happen implicitly.

## Launch options

`launch-options.json` lives in the state directory alongside `mod-sets.json`:
daemon-wide defaults plus each world's overrides, both applied at the
world's next start (the game only reads its command line at launch).

`LAUNCH_OPTION_FIELDS` in `daemon/src/launch-options-schema.ts` is the single
source of truth for which options exist, their types and their limits.
`nogui`, `datadir` and `world` are deliberately excluded: they are the
daemon's own arguments, and their absence from this list is the whole
mechanism that keeps a user from overriding them (`process-manager.ts` also
filters them out of supplied options and writes its own values last, so even
a filter bypass would still resolve to the daemon's value under the game's
last-flag-wins parser). `settings` and `logs` are excluded too: `settings`
would create a second source of truth that these options then override, and
`logs` moves a log directory the daemon does not read from anyway.

`DaemonConfig.owners` (an array) is retired. The game's own
`parseLaunchOptions` builds a plain map from its command-line flags, so
repeated `-owner` flags overwrite each other and only the last one survives
a launch. Launch options now hold a single `owner` string instead, and
`launch-options-migration.ts` moves an existing `config.json`'s `owners`
array to it (seeding the first entry) the first time the daemon boots after
upgrading.

## Testing

Cover the seam, not just each side of it. 113 daemon tests and 6 client tests
once passed while **five of the app's actions were completely broken**: the
daemon's tests use Fastify's `inject()` (which never sets a content-type) and
the client's mocked `fetch` (which never reaches Fastify), so a bodyless POST
carrying a JSON content-type failed in production and nowhere else.
`client/test/api.integration.test.ts` exists to close that gap — it stands up a
real daemon on an ephemeral port and drives it with the real client transport.
Keep it that way; a test that mocks either side proves nothing about the seam.

Real captured server output lives in `daemon/test/fixtures/log-fixtures.ts`.
The game's stdout carries **ANSI colour escapes before the timestamp** — that
broke shutdown detection and was invisible to every unit test. Do not
"normalise" those fixtures; they are evidence.

## World save zips

`daemon/src/world-settings*.ts` rewrites a file inside a world zip, which is
the only copy of that world. The write is build-elsewhere → re-open and
hash-verify every entry → fsync → back up → rename, in that order, and the
verification is load-bearing: a rebuild that silently drops an entry is still a
*valid* zip and only the per-entry hash catches it. Unknown keys in
`worldSettings.cfg` come from mods and must round-trip untouched; the editor
never adds a key the file did not already have.
