# Daemon installer verification — 2026-07-30

Task 7 of the daemon-installer plan: run everything the plan's verification
harness can run, and record plainly what it structurally cannot. Read the
[Not verified](#not-verified) section before treating anything else here as
coverage of the installer as a whole — it is coverage of the silent,
non-elevated, scratch-directory path only.

**Branch** `feat/daemon-installer` at `a72272421e7c90750f425e3c34a1161f108ae0df`.
**Machine** a workstation (`jeff-desktop`), not SERVER. **Session** not
elevated — `whoami` is `jeff-desktop\jpegg`, and
`[Security.Principal.WindowsPrincipal]::...IsInRole(Administrator)` returned
`False` for the whole run. That single fact is why several of the gaps below
exist: this harness cannot produce an elevated UAC prompt to answer.

---

## Step 1 — Full suite and typecheck

All four commands, run for real, all `EXIT=0`.

```
$ cd daemon; npx vitest run
 Test Files  23 passed (23)
      Tests  476 passed (476)
EXIT=0

$ cd daemon; npx tsc --noEmit
EXIT=0

$ cd client; npx vitest run
 Test Files  13 passed (13)
      Tests  272 passed (272)
EXIT=0

$ cd client; npx tsc --noEmit
EXIT=0
```

476 daemon tests, 272 client tests, both packages typecheck clean.

## Step 2 — Both installer verification scripts

### `installer/verify-shims.ps1`

```
PASS  falls back to PATH node when no bundled runtime
PASS  without bundled runtime AND without PATH node, it cannot run
PASS  uses the bundled runtime when PATH has no node

FAILURES: 0
```

### `installer/verify-installer.ps1`

Built the real payload (`npm run build`, `stage-daemon.ps1`, `fetch-node.ps1`
pulling and checksum-verifying node-v22.20.0), compiled a harness copy of the
`.iss`, then ran a full silent install, a bundled-runtime substitution proof,
a silent uninstall with a seeded state directory, a second install/uninstall
pair with both tasks selected and no `/SUPPRESSMSGBOXES` (to prove those runs
complete rather than hang and that the boot-task notice really fires), and the
Finding-G regression case (bare `/VERYSILENT`, no `/TASKS`, an
already-configured state directory) with a sentinel `register-task.ps1` in
place of the real one. All inside one scratch directory under `%TEMP%`, with
`NECESSE_MANAGER_DATA` pointed at it throughout.

```
Using ISCC:       C:\Users\jpegg\AppData\Local\Programs\Inno Setup 6\ISCC.exe
Running elevated: False
...
PASSES: 64
FAILURES: 0
```

Every one of the 64 checks passed, including the byte-identical
state-directory manifest across the uninstall, the bundled-node substitution
proof (moving `node.exe` aside makes the launcher fail with "is not
recognized", proving the earlier pass was not silently falling through to
system Node), and the Finding-G regression control (`boottask=no`,
`register-task.ps1` never invoked, on a machine `verify-installer.ps1` itself
confirms was already configured).

### The harness's one deliberate deviation from the shipped `.iss`

`Build-Setup` in `verify-installer.ps1` compiles a byte-for-byte copy of
`installer/necesse-daemon.iss` except for one line, and only because this
session is not elevated:

```
PrivilegesRequired=admin        (shipped)
PrivilegesRequired=lowest       (harness copy, non-elevated session only)
```

Say this plainly: **the 64 passes above are not a compile of the committed
file.** Every install and uninstall in that run registered under `HKCU`, not
`HKLM` (visible in the "Add/Remove Programs entry registered" line above:
`HKCU:\SOFTWARE\...`), used the per-user Start Menu profile, and never
triggered a UAC prompt. See [Not verified](#not-verified) for what that
costs.

## An independent compile of the committed `.iss`, unmodified

Separately from the harness, `installer/necesse-daemon.iss` was compiled
exactly as committed — `PrivilegesRequired=admin` untouched — against a
minimal scratch stage directory, to confirm the shipped script parses and
builds on its own:

```
$ ISCC.exe /DStageDir=<scratch>\stage /DAppVersion=9.9.9-committed-iss-check /DOutDir=<scratch>\out installer\necesse-daemon.iss
Compiler engine version: Inno Setup 6.7.3
...
Successful compile (0.563 sec). Resulting Setup program filename is:
<scratch>\out\necesse-daemon-v9.9.9-committed-iss-check-setup.exe
```

This proves the `[Code]` section parses and the `.iss` compiles with the real
`PrivilegesRequired=admin` value in place. It proves nothing about what that
setup.exe does when run — it was not executed. Running it would have popped a
UAC prompt this session cannot answer, so it was left uninvoked, and the
resulting exe was left in the scratchpad, never copied anywhere it could be
double-clicked by accident.

## Step 3 — The real state directory, and everything else left on the machine

Checked before Step 2 ran and again after:

```
$ Get-ChildItem "$env:PROGRAMDATA\NecesseServerManager" -ErrorAction SilentlyContinue
(nothing)
$ Test-Path "$env:PROGRAMDATA\NecesseServerManager"
False
```

Unchanged — `verify-installer.ps1`'s own "real %PROGRAMDATA%\NecesseServerManager
unchanged" check agrees (`existed before=False, exists after=False`), and this
was confirmed independently rather than taking that line on faith. After both
scripts finished, checked every location the installer or uninstaller can
touch:

| Check | Result |
|---|---|
| `HKLM:\...\Uninstall\{7B1B3E2A...}_is1` | absent |
| `HKLM:\...\WOW6432Node\...\Uninstall\{7B1B3E2A...}_is1` | absent |
| `HKCU:\...\Uninstall\{7B1B3E2A...}_is1` | absent |
| `%APPDATA%\...\Start Menu\Programs\Necesse Server Manager` | absent |
| `%ProgramData%\...\Start Menu\Programs\Necesse Server Manager` | absent |
| `NecesseDaemon` scheduled task | absent |
| `NecesseDaemon-Inbound` firewall rule | absent |
| Port 8710 listeners | none |
| Stray `necesse-daemon*`, `unins*`, `_iu*`, `ISCC` processes | none |
| `node.exe` processes | 4 running, all `C:\nvm4w\nodejs\node.exe` — pre-existing tooling on this box, unrelated to the installer (its bundled runtime lives under a scratch `\node\node.exe`, never that path) |

Nothing from this work is installed on this machine, and the scratch exe from
the independent compile above was never run.

---

## What "green" means here, and what it does not

This installer was built task by task with an independent review after each
task, and the review process itself is part of the evidence this document
should convey honestly. Several of the most serious defects were found not by
reasoning about Inno's documented behavior but by a reviewer building a
throwaway probe installer and *measuring* what Inno actually did. Two are
worth naming because both were, at the time, invisible to this same
verification harness:

- **`SuppressibleMsgBox` does not return the supplied default under plain
  `/VERYSILENT`.** A fix that read as correct — pass `MB_DEFBUTTON2` /
  `IDNO` as the default and trust it under silence — was measured directly
  with `MB_OK` and found to show a real, invisible modal box that blocks
  forever; it only honours `Default` when `/SUPPRESSMSGBOXES` is *also*
  passed. `installer/necesse-daemon.iss` now decides silence explicitly with
  `WizardSilent`/`UninstallSilent` before any dialog exists to answer
  wrongly (see `NotifyInstall`/`NotifyUninstall` and the FINDING C comment
  in the `.iss`), rather than leaning on a message-box default.
- **A later fix silently re-enabled the boot task on unattended upgrades.**
  Making `CurPageChanged` skip entirely under `WizardSilent` was the correct
  fix for a different defect (silent runs ignoring `/TASKS`), but it meant an
  unattended `setup.exe /VERYSILENT` with no `/TASKS` switch at all fell
  through to the `[Tasks]` section's own default — which was `checked` — on
  a machine whose operator had deliberately never registered a boot task.
  This is Finding G, and it is why the `[Tasks]` section now defaults
  `boottask` to `unchecked` and `verify-installer.ps1` carries the dedicated
  regression case reproduced in Step 2 above.

Both were defects a green run of the *previous* version of this harness would
not have caught, because the harness itself did not yet cover the topology
that exposed them (plain `/VERYSILENT` with no `/TASKS`, on an
already-configured machine). The 64 passes recorded in Step 2 above are real,
but they are evidence about the topologies this harness exercises — not proof
that no comparable gap remains in a topology it does not.

---

## Not verified

Nothing below was exercised by this task. A green result above says nothing
about any of it.

### Neither GitHub Actions workflow has run

`ci.yml`'s "Build the daemon installer" step and `release.yml`'s installer
build-and-publish job have never executed on GitHub. Both are new since the
last time either workflow ran for real (`verification-2026-07-29-server-upgrade.md`
recorded `ci.yml` and `release.yml` succeeding, but that was before this
branch existed). The only compiles of `necesse-daemon.iss` that have ever
happened are the local ones in this document — none of them on
`windows-latest`, none of them via `choco install innosetup`, none of them as
part of a tag-triggered release.

### The elevated install path was never exercised

Every install and uninstall in `verify-installer.ps1`'s 64-check run compiled
and ran against `PrivilegesRequired=lowest`, because this session could not
answer a UAC prompt. That means, on the real shipped `.iss`
(`PrivilegesRequired=admin`), none of the following has been exercised by
this task:

- The UAC consent prompt itself, and setup re-launching elevated.
- `{autopf}` (`Program Files`) as the actual install target — the harness
  installed to a scratch directory under a lowest-privilege session, which
  Inno permits regardless of `DefaultDirName`.
- The `HKLM` Add/Remove Programs entry. Every registration observed above,
  in both the 64-check run and the independent live checks in Step 3, landed
  under `HKCU`.
- The common-profile Start Menu group (`%ProgramData%\...\Start Menu\...`).
  The harness's own comment on the shortcut check says as much: "the one
  place the elevated path is ever exercised" is CI, which has not run.
- Writing to `{code:StateDirConst}` when that resolves under `%ProgramData%`
  for real (an elevated, non-overridden machine) rather than a scratch
  directory reached only via `NECESSE_MANAGER_DATA`.

Say plainly: **the shipped `.iss` is never compiled exactly as-is by the
local harness.** `Build-Setup` always patches
`PrivilegesRequired=admin` to `PrivilegesRequired=lowest` on a non-elevated
session, which every session on this machine is. The independent compile
above proves the unmodified file parses and builds; it proves nothing about
running it.

### `scripts/03-register-task.ps1` was never executed

Both the main `verify-installer.ps1` run and its Finding-G regression case
install a *sentinel* `register-task.ps1` — either the never-selected branch,
or (in the regression case) a stub that writes a marker file instead of
calling `schtasks.exe`. The harness proves the installer's own *decision*
about whether to invoke that script (selected vs. not, based on `/TASKS`,
`ConfigExists()`, and silence) is correct. It proves nothing about
`scripts/03-register-task.ps1` itself — the script that would actually run
`schtasks.exe /create`, bind port 8710, and hand back a running boot task.
That script was not run once during this task, on SERVER or anywhere else,
per this task's constraints.

The uninstaller's real task-removal (`schtasks.exe /delete /tn NecesseDaemon
/f`) and firewall-removal
(`Remove-NetFirewallRule -Name NecesseDaemon-Inbound`) branches are
unexercised for the same structural reason: every uninstall in this task ran
against an install that never had a real scheduled task or firewall rule to
remove, because task registration was never selected (main run) or was
sentinel-stubbed (Finding-G case). The `NotifyUninstall` failure-dialog paths
for "could not delete the task" / "could not remove the firewall rule" have
never fired, successfully or otherwise.

### The interactive path was never run

No install or uninstall in this task ran without `/VERYSILENT`. Consequently
none of the following has been seen even once:

- The wizard actually drawn — the license/info pages, the `wpSelectTasks`
  checkbox page with its `runsetup`/`boottask` defaults computed by
  `CurPageChanged`, the finish page.
- Any of the non-suppressed `MsgBox` calls rendered as a real, visible modal:
  the session-preflight confirmation (`RunSessionPreflight`), the
  post-install failure/info notices (`NotifyInstall`), the uninstall
  preflight confirmation (`ConfirmUninstallProceed`), or the "daemon has
  been removed, your mod library is still here" notice
  (`NotifyUninstall` in `usPostUninstall`). Every one of those has only ever
  been exercised as a `Log('Notice (silent, not shown): ...')` line in an
  Inno log file.
- A human overriding a computed checkbox default — clicking "boottask" on
  or off against what `CurPageChanged` pre-selected. The harness asserts
  what the defaults *compute to*; nobody has ever clicked against them.
- The interactive `setup.cmd` launch from `ssPostInstall`
  (`WizardIsTaskSelected('runsetup') and not ConfigExists()`), which needs a
  visible console window and a person answering prompts. Every install in
  this task either had `runsetup` deselected or ran silently, which takes
  the "not launching the interactive setup wizard" log branch instead.

### The session preflight's refusing branches were never triggered against a real daemon

`RunSessionPreflight` (install) and the uninstall-side preflight script both
have two refusing outcomes — `CheckCode=2` ("a game session may still be
running") and `CheckCode=3`/`CANNOT_DETERMINE` — gated behind an actual
`GET /api/status` call to `http://localhost:<port>/api/status`. No daemon was
running on this machine at any point during this task (port 8710 was
confirmed free before Step 2 and after), so every preflight check in every
run here took the `CheckCode=0` "nothing is listening, proceed" branch. The
live-session abort, the cannot-determine abort, and their interactive
confirm-and-force-stop counterparts are exercised only by
`preflight.ps1`'s and the uninstall script's own unit-level checks against a
fake HTTP listener (recorded in the plan's task-3 report), never against a
real running daemon here.

### An upgrade over an existing installation was never performed

Every install in this task, in every scenario, started from a clean AppId —
`verify-installer.ps1` asserts "no stale Add/Remove Programs entry for this
AppId" before doing anything. The one case that pre-populates anything
pre-creates the *state directory* (`config.json` plus a seeded mod jar), not
a prior install of the daemon itself. `StopDaemonTask`'s reason for
existing — that `node.exe` cannot be overwritten while a previous version's
daemon still holds it, and the port needs to be released before the new one
binds — has never been exercised, because no run in this task has ever
installed the same AppId twice in a row without uninstalling in between.

### Nothing was installed on the real server, and the installer has not been run outside a scratch directory

Every install and uninstall in this task happened inside a directory under
`%TEMP%`, on a workstation, with `NECESSE_MANAGER_DATA` redirected to another
directory under the same scratch root. The installer has never been copied
to, or run on, SERVER (`192.168.1.106`) or any machine that is not this
workstation, and it has never been run against the real
`%PROGRAMDATA%\NecesseServerManager` or the real port 8710 that a live daemon
would use. Per this task's constraints, nothing under `scripts/` was run
either — so even the non-installer path to a running daemon
(`02-deploy.ps1` / `03-register-task.ps1` / `04-restart-daemon.ps1`) was
untouched this session.
