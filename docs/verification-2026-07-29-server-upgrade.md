# Live server upgrade — 2026-07-29

The real thing: this branch deployed to SERVER and the one-time state migration
run against a real install, with the game server stopped. Third document of the
day, after
[`verification-2026-07-29.md`](verification-2026-07-29.md) (suites) and
[`verification-2026-07-29-artifacts.md`](verification-2026-07-29-artifacts.md)
(local build and boot). This one supersedes both documents' claim that nothing
had touched the real server.

**Branch** `feat/shareable-release` at `7bbe522`. Daemon runs as
`SYSTEM`, task `NecesseDaemon`, boot trigger, port 8710.

---

## The Critical finding was real, on this machine

The whole-branch review predicted that `config.json` on the live server stored
`modLibraryDir`/`modLibraryFile`/`modSetsFile` as paths inside the install
directory, which would have made the documented "delete the install directory
and unzip the new release" upgrade destroy the only copy of every uploaded jar.
Read off the live box **before** deploying anything:

```
modLibraryDir    C:\Users\jeffp\necesse-daemon\mod-library
modLibraryFile   C:\Users\jeffp\necesse-daemon\mod-library.json
modSetsFile      C:\Users\jeffp\necesse-daemon\mod-sets.json
mod-library      True (11 entries)
```

Eleven mods, in a directory the README tells the operator to delete. The
prediction was correct and the fix was load-bearing rather than theoretical.

Pre-deploy state also confirmed: `authToken` **absent** (so authentication stays
disabled and the existing client keeps working, exactly as the spec's upgrade
path claimed); `modsDir`/`worldsDir` stored and **agreeing** with `dataDir` (so
the drift guard passes rather than refusing); `C:\ProgramData\NecesseServerManager`
absent; none of `setup.cmd`/`start-daemon.cmd`/`migrate.cmd` present on the
server, which is the defect the deploy script was fixed to address; and **zero
java processes**, confirming no game session was at risk.

## The upgrade, step by step, as it actually went

**1. Deploy.** `02-deploy.ps1` copied `dist/`, both manifests and the three
`.cmd` shims, then ran `npm ci --omit=dev` remotely. Worth recording: the local
`npm ci` (with dev dependencies) reports `5 vulnerabilities (3 moderate, 1 high,
1 critical)` while the remote production-only install reports `found 0
vulnerabilities`. The advisories are entirely in the client's build tooling and
do not ship in the daemon.

**2. Restart, and the designed refusal.** `04-restart-daemon.ps1` stopped the
task, started it, and the new daemon refused to boot. What the operator saw was
the daemon's own explanation, not a bare task-state error:

```
This daemon keeps its state in C:\ProgramData\NecesseServerManager, but
C:\Users\jeffp\necesse-daemon still holds an older install's state (config.json,
mods.json, mod-sets.json, mod-library.json, mod-library) and the state directory
is empty.

Run migrate.cmd from the install folder to copy it across. It copies rather than
moves and verifies what it wrote, so the originals stay where they are until you
delete them.
```

This is the `Show-DaemonRefusal` fix working. Without it the entire visible
output would have been `NecesseDaemon did not reach Running (state: Ready)`,
because a Scheduled Task's stdout goes nowhere. The same text was also written to
`C:\ProgramData\NecesseServerManager\boot-refusal.txt` and echoed from there.

**3. Migrate.** `migrate.cmd`, run with nothing holding the install-directory
state:

```
Copied and verified: config.json, mods.json, mod-sets.json, mod-library.json, mod-library
The originals in C:\Users\jeffp\necesse-daemon were left alone.
```

**4. Restart again.**

```
STOPPED_STATE=Ready
STARTED_STATE=Running
{"state":"stopped","world":null,...,"activeTasks":[],"configWarnings":[]}
```

`configWarnings` is empty, so steamcmd was found at its configured path.

## Nothing was lost

Read back from the live daemon after the restart:

| Check | Result |
|---|---|
| `modLibraryDir` the daemon actually uses | `C:\ProgramData\NecesseServerManager\mod-library` |
| `modLibraryFile` / `modSetsFile` | both under `C:\ProgramData\NecesseServerManager` |
| Worlds | 5 — Infected Toenail, Summoner World, Tulsa, Goober Goof, Jeff and Eli |
| `lastWorld` | Infected Toenail |
| Mods in the folder | 10 managed, **0 untracked** |
| Mod library | **11 entries**, all named |
| Per-world mod sets | all 5 `configured=True`, 8 to 9 mods each |
| Steam API key | still configured |
| `authRequired` | `false` — the existing client keeps working |
| `boot-refusal.txt` after a healthy boot | removed |
| Originals in the install directory | all 5 still present |

The first row is C1's fix verified in production: the daemon **ignores** the
install-directory paths still sitting in the migrated `config.json` and derives
the state-directory ones instead. That is what makes the install directory
disposable, which is what makes the documented upgrade safe.

## CI

`ci.yml` ran on GitHub for the first time and passed in 1m54s (run
`30510838190`), so the earlier document's "neither workflow has ever run" is now
half closed.

## Still not verified

- **`release.yml` has never run.** It triggers on a `v*` tag and no tag exists.
- **No world has been started on the new build.** The daemon reports `stopped`
  and was not asked to launch a session, so mod reconciliation at start, the
  `-datadir` launch path and a graceful save-and-stop are all still only
  verified against the *previous* build (see
  [`verification-2026-07-27.md`](verification-2026-07-27.md)).
- **The built client was never launched**, so the connection screen, the token
  round trip and the widened CSP are unexercised in a real WebView.
- **The old originals in `C:\Users\jeffp\necesse-daemon` have not been deleted.**
  That is deliberate: `migrate.cmd` copies rather than moves so the operator
  deletes them once satisfied. Until then the install directory is not actually
  disposable on this machine, and a `git clean`-style wipe of it would still be
  survivable only because ProgramData now holds the real copy.
- **steamcmd under SYSTEM remains unproven.** The daemon now runs as SYSTEM
  against the new state directory, but no mod install or server update has been
  attempted, so the anonymous-login handshake is still untested.
