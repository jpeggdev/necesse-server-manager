# Daemon Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows installer for the daemon alongside the existing release zip: one elevated run that places the files, brings its own Node, runs the existing setup wizard, registers the scheduled task and firewall rule, and uninstalls cleanly without ever touching the state directory.

**Architecture:** An Inno Setup script consumes a staged directory that is built by two small PowerShell scripts shared with the release workflow — one that stages the daemon payload (the same content as the zip), one that fetches a checksum-verified private Node runtime into it. The three `.cmd` shims and `register-task.ps1` gain a preference for that bundled runtime with a fallback to `PATH`, so a single set of launchers serves both the installer and the zip.

**Tech Stack:** Inno Setup 6 (ISCC), PowerShell 5.1/7 for staging and verification, Node 22 runtime from nodejs.org, GitHub Actions on `windows-latest`.

**Spec:** `docs/superpowers/specs/2026-07-30-daemon-installer-design.html`

## Global Constraints

- **Work on branch `feat/daemon-installer`**, branched from `feat/shareable-release`. Never commit to `main`.
- **Uninstall must never delete or modify `%PROGRAMDATA%\NecesseServerManager`.** `mod-library\` is the only copy of every uploaded and hand-placed mod jar. There is no "also remove my data" option, by design.
- **The daemon zip's contents must not change.** It continues to ship without a bundled Node. Only the `.cmd` shims change, and they change in a way that is a no-op when no bundled runtime is present.
- **The setup wizard is the only implementation of config writing.** Do not reimplement path probing, validation or token generation in installer script.
- **Never `git push`** unless the plan step says to. Never run `scripts/02-deploy.ps1`, `scripts/04-restart-daemon.ps1` or anything else that reaches the live server.
- **Do not run `npx tauri build`** — it is slow and irrelevant to this work.
- Existing verification still applies: from `daemon/` `npx vitest run` and `npx tsc --noEmit`; from `client/` the same. All four stay green.
- **Windows.** Read/Edit/Write/Glob/Grep with native Windows paths; PowerShell tool for commands; Bash only for `git`.
- No comments that restate the code. Comment only a non-obvious *why*; match the density of the surrounding files, which explain reasoning and consequences.

---

### Task 1: Shims and the scheduled task prefer a bundled Node

**Files:**
- Modify: `daemon/setup.cmd`, `daemon/start-daemon.cmd`, `daemon/migrate.cmd`
- Modify: `scripts/03-register-task.ps1` (the node-resolution block, currently lines 78-90)
- Create: `installer/verify-shims.ps1`

**Interfaces:**
- Consumes: nothing.
- Produces: the convention that `<install dir>\node\node.exe`, when present, is the runtime every launcher uses. Tasks 2 and 3 place a file at exactly that path.

- [ ] **Step 1: Write the failing verification script**

Create `installer/verify-shims.ps1`:

```powershell
$ErrorActionPreference = "Stop"
# Proves the shims prefer a bundled runtime and still work without one.
#
# The bundled case runs with node stripped from PATH. Without that, a shim that
# ignored the bundled copy entirely would pass identically by falling through to
# the system Node - which is the whole behaviour under test.
$sp = Join-Path $env:TEMP ("shimtest-" + [guid]::NewGuid().ToString("N"))
$repo = Split-Path -Parent $PSScriptRoot
$fails = 0
function Check($n, $ok, $d) {
  if ($ok) { Write-Host "PASS  ${n}  ${d}" } else { Write-Host "FAIL  ${n}  ${d}"; $script:fails++ }
}

$realNode = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Force (Join-Path $sp "dist") | Out-Null
Copy-Item (Join-Path $repo "daemon\start-daemon.cmd") $sp
# A stand-in for the daemon: the shim's job is to run dist\index.js with SOME
# node, and printing a marker is all that has to be observed to know it did.
Set-Content -Path (Join-Path $sp "dist\index.js") -Value 'console.log("SHIM_OK");' -Encoding ASCII

$safePath = "C:\Windows\System32;C:\Windows"

# 1. No bundled runtime, node on PATH: falls back, as the zip does.
$out1 = & cmd /c "set `"PATH=$env:PATH`" && `"$sp\start-daemon.cmd`"" 2>&1 | Out-String
Check "falls back to PATH node when no bundled runtime" ($out1 -match "SHIM_OK") ""

# 2. No bundled runtime, no node on PATH: fails, proving the probe below is real.
$out2 = & cmd /c "set `"PATH=$safePath`" && `"$sp\start-daemon.cmd`"" 2>&1 | Out-String
Check "without bundled runtime AND without PATH node, it cannot run" (-not ($out2 -match "SHIM_OK")) ""

# 3. Bundled runtime present, no node on PATH: must still work.
New-Item -ItemType Directory -Force (Join-Path $sp "node") | Out-Null
Copy-Item $realNode (Join-Path $sp "node\node.exe")
$out3 = & cmd /c "set `"PATH=$safePath`" && `"$sp\start-daemon.cmd`"" 2>&1 | Out-String
Check "uses the bundled runtime when PATH has no node" ($out3 -match "SHIM_OK") ""

Remove-Item -Recurse -Force $sp -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "FAILURES: $fails"
if ($fails -gt 0) { exit 1 }
```

- [ ] **Step 2: Run it to verify case 3 fails**

Run: `pwsh -NoProfile -File installer\verify-shims.ps1`
Expected: cases 1 and 2 PASS, case 3 **FAILS** — the shim currently calls a bare `node`, which is not on the stripped PATH, so the bundled copy is never consulted.

- [ ] **Step 3: Change the three shims**

`daemon/start-daemon.cmd`:

```bat
@echo off
setlocal
cd /d "%~dp0"
rem The installer ships a private Node beside these shims; the release zip does
rem not and uses whatever is on PATH. One set of shims serves both artifacts,
rem because two sets would drift.
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" dist\index.js %*
endlocal
```

`daemon/setup.cmd` — identical but for the last command:

```bat
@echo off
setlocal
cd /d "%~dp0"
rem The installer ships a private Node beside these shims; the release zip does
rem not and uses whatever is on PATH. One set of shims serves both artifacts,
rem because two sets would drift.
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" dist\setup-cli.js %*
endlocal
```

`daemon/migrate.cmd` — same, with `dist\migrate-cli.js`.

- [ ] **Step 4: Run the verification again**

Run: `pwsh -NoProfile -File installer\verify-shims.ps1`
Expected: all three PASS, `FAILURES: 0`.

- [ ] **Step 5: Change the node resolution in `scripts/03-register-task.ps1`**

Replace the block that currently begins `$node = $null` and ends with the `throw "node.exe not found..."` line with:

```powershell
$node = $null
# The installer ships a private Node in the install directory. Prefer it over
# anything on PATH: the scheduled task stores whatever path is resolved here
# LITERALLY, so a task pointed at the bundled runtime keeps working when the
# operator upgrades, downgrades or uninstalls their own Node - which is exactly
# the kind of unrelated action that would otherwise silently break the daemon at
# the next boot, hours later, with nothing to connect the two events.
$bundled = Join-Path $dir "node\node.exe"
if (Test-Path $bundled) { $node = $bundled }
if (-not $node) {
  try { $node = (Get-Command node.exe -ErrorAction Stop).Source } catch {}
}
if (-not $node) {
  # PATH may not be visible in this session yet (see 01-install-node.ps1's
  # note on sshd not picking up a machine-PATH change until restarted).
  $fallback = "C:\Program Files\nodejs\node.exe"
  if (Test-Path $fallback) { $node = $fallback }
}
if (-not $node) { throw "node.exe not found: no bundled runtime at $bundled, nothing named node.exe on PATH, and nothing at C:\Program Files\nodejs\node.exe." }
```

Note it resolves against `$dir` (the install directory) rather than `$PSScriptRoot`, because `deploy.local.ps1` may set `$InstallDir` to something other than where the script sits.

- [ ] **Step 6: Confirm the script still parses and nothing else broke**

Run from the repo root:

```powershell
$errs = $null; $toks = $null
[System.Management.Automation.Language.Parser]::ParseFile("$PWD\scripts\03-register-task.ps1", [ref]$toks, [ref]$errs) | Out-Null
"parse_errors=$($errs.Count)"
```
Expected: `parse_errors=0`. Do **not** execute the script — it registers a scheduled task.

Then from `daemon/`: `npx vitest run` and `npx tsc --noEmit`; from `client/`: the same. All four green.

- [ ] **Step 7: Commit**

```bash
git add daemon/setup.cmd daemon/start-daemon.cmd daemon/migrate.cmd scripts/03-register-task.ps1 installer/verify-shims.ps1
git commit -m "feat(daemon): prefer a bundled Node runtime when one ships beside the launchers"
```

---

### Task 2: Staging scripts, with a checksum-verified Node

**Files:**
- Create: `installer/node-version.txt`
- Create: `installer/stage-daemon.ps1`
- Create: `installer/fetch-node.ps1`

**Interfaces:**
- Consumes: the `node\node.exe` convention from Task 1.
- Produces:
  - `installer/stage-daemon.ps1 -RepoRoot <path> -StageDir <path>` — populates `$StageDir` with exactly the daemon zip's contents.
  - `installer/fetch-node.ps1 -StageDir <path> [-RepoRoot <path>]` — adds `node\node.exe` to an already-staged directory.
  - `installer/node-version.txt` — one line, the pinned Node version without a leading `v`.

Two scripts rather than one switch, because the release workflow needs the zip built from a stage that has **no** Node in it, and then the installer built from that same stage **with** Node added. Splitting is what lets it stage once.

- [ ] **Step 1: Pin the Node version**

Create `installer/node-version.txt` containing exactly one line:

```
22.20.0
```

Then verify that version actually exists before relying on it:

```powershell
$v = (Get-Content installer\node-version.txt -Raw).Trim()
$r = Invoke-WebRequest "https://nodejs.org/dist/v$v/SHASUMS256.txt" -SkipHttpErrorCheck -TimeoutSec 30
"version=$v status=$($r.StatusCode)"
```

Expected: `status=200`. **If it is 404**, pick the highest `22.x.x` release instead and write that into the file:

```powershell
$idx = Invoke-RestMethod "https://nodejs.org/dist/index.json" -TimeoutSec 30
$latest22 = ($idx | Where-Object { $_.version -like "v22.*" } | Select-Object -First 1).version.TrimStart("v")
Set-Content -Path installer\node-version.txt -Value $latest22 -NoNewline
"pinned=$latest22"
```

Record in the report which version ended up pinned and whether the fallback was needed.

- [ ] **Step 2: Write `installer/stage-daemon.ps1`**

```powershell
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RepoRoot,
  [Parameter(Mandatory)][string]$StageDir
)
$ErrorActionPreference = "Stop"

# The daemon payload, identical to what the release zip contains. Shared by the
# release workflow, CI and the local installer verification so there is one
# definition of "what ships" rather than three that drift.
if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

Copy-Item -Recurse (Join-Path $RepoRoot "daemon\dist") (Join-Path $StageDir "dist")
Copy-Item (Join-Path $RepoRoot "daemon\package.json"),(Join-Path $RepoRoot "daemon\package-lock.json") $StageDir
Copy-Item (Join-Path $RepoRoot "daemon\setup.cmd"),(Join-Path $RepoRoot "daemon\start-daemon.cmd"),(Join-Path $RepoRoot "daemon\migrate.cmd") $StageDir
# Renamed on purpose: the setup wizard's closing message tells the operator to
# run "register-task.ps1", and the daemon's own boot refusals name files by
# their unqualified name. A copy under the numbered source name would make
# every printed instruction wrong.
Copy-Item (Join-Path $RepoRoot "scripts\03-register-task.ps1") (Join-Path $StageDir "register-task.ps1")
Copy-Item (Join-Path $RepoRoot "config.example.json") $StageDir

Push-Location $StageDir
try {
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm ci --omit=dev failed in $StageDir (exit $LASTEXITCODE)" }
} finally { Pop-Location }

Write-Host "Staged daemon payload at $StageDir"
```

- [ ] **Step 3: Write `installer/fetch-node.ps1`**

```powershell
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$StageDir,
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = "Stop"

$version = (Get-Content (Join-Path $RepoRoot "installer\node-version.txt") -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "installer\node-version.txt does not contain a bare version like 22.20.0 (got '$version')." }

$archive = "node-v$version-win-x64.zip"
$baseUrl = "https://nodejs.org/dist/v$version"
$work = Join-Path $env:TEMP ("nodefetch-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null

try {
  $zip = Join-Path $work $archive
  Invoke-WebRequest "$baseUrl/$archive" -OutFile $zip -TimeoutSec 300
  $sums = Join-Path $work "SHASUMS256.txt"
  Invoke-WebRequest "$baseUrl/SHASUMS256.txt" -OutFile $sums -TimeoutSec 60

  # This binary is about to be shipped to other people under the maintainer's
  # name. An unverified download is the one place a supply-chain problem could
  # enter this project, and checking costs three lines.
  $expectedLine = @(Get-Content $sums | Where-Object { $_ -match [regex]::Escape($archive) + '$' })
  if ($expectedLine.Count -ne 1) { throw "Expected exactly one SHASUMS256.txt entry for $archive, found $($expectedLine.Count)." }
  $expected = ($expectedLine[0] -split '\s+')[0].ToLower()
  $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) { throw "SHA-256 mismatch for ${archive}: expected $expected, got $actual. Refusing to bundle it." }
  Write-Host "Verified $archive ($expected)"

  Expand-Archive -Path $zip -DestinationPath $work -Force
  $src = Join-Path $work "node-v$version-win-x64\node.exe"
  if (-not (Test-Path $src)) { throw "node.exe not found at $src after extracting $archive." }
  $dest = Join-Path $StageDir "node"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item $src (Join-Path $dest "node.exe")
  Write-Host "Bundled Node $version into $dest"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
```

- [ ] **Step 4: Run both against a scratch stage and verify**

```powershell
cd C:\Users\jpegg\code\necesse-projects\server-gui\daemon; npm run build; cd ..
$stage = Join-Path $env:TEMP "stagetest"
pwsh -NoProfile -File installer\stage-daemon.ps1 -RepoRoot $PWD -StageDir $stage
pwsh -NoProfile -File installer\fetch-node.ps1 -StageDir $stage -RepoRoot $PWD
Get-ChildItem $stage | Select-Object Name
"node_exe_present=$(Test-Path (Join-Path $stage 'node\node.exe'))"
& (Join-Path $stage "node\node.exe") --version
```

Expected: the stage lists `dist`, `node`, `node_modules`, `config.example.json`, `migrate.cmd`, `package-lock.json`, `package.json`, `register-task.ps1`, `setup.cmd`, `start-daemon.cmd`; `node_exe_present=True`; and the bundled binary reports the pinned version.

- [ ] **Step 5: Prove the checksum check actually rejects a bad file**

Temporarily change the `$expected` line in `fetch-node.ps1` to `$expected = "0" * 64`, re-run `fetch-node.ps1`, and confirm it throws `SHA-256 mismatch`. Restore the line and re-run to confirm it succeeds. A verification that has never been seen to fail is not a verification. Put both outputs in the report.

- [ ] **Step 6: Commit**

```bash
git add installer/node-version.txt installer/stage-daemon.ps1 installer/fetch-node.ps1
git commit -m "feat(installer): stage the daemon payload and a checksum-verified private Node"
```

---

### Task 3: The Inno Setup script

**Files:**
- Create: `installer/necesse-daemon.iss`

**Interfaces:**
- Consumes: a staged directory produced by Task 2's two scripts.
- Produces: `ISCC.exe /DStageDir=<abs path> /DAppVersion=<x.y.z> /DOutDir=<abs path> installer\necesse-daemon.iss` emits `<OutDir>\necesse-daemon-v<AppVersion>-setup.exe`.

- [ ] **Step 1: Ensure Inno Setup is available**

```powershell
$iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) { winget install --id JRSoftware.InnoSetup --silent --accept-package-agreements --accept-source-agreements }
Test-Path $iscc
```
Expected: `True`. If winget fails, report BLOCKED rather than improvising another install route.

- [ ] **Step 2: Write `installer/necesse-daemon.iss`**

```pascal
; Installer for the Necesse Server Manager daemon.
;
; Built against a directory staged by installer\stage-daemon.ps1 plus
; installer\fetch-node.ps1, so the payload here is exactly the release zip's
; contents plus a private node\node.exe.
;
; Required defines:
;   StageDir   absolute path to the staged payload
;   AppVersion x.y.z, used in the output filename and Add/Remove Programs
;   OutDir     absolute path to write the installer into

#ifndef StageDir
  #error StageDir is not defined. Pass /DStageDir=<absolute path>.
#endif
#ifndef AppVersion
  #error AppVersion is not defined. Pass /DAppVersion=<x.y.z>.
#endif
#ifndef OutDir
  #error OutDir is not defined. Pass /DOutDir=<absolute path>.
#endif

[Setup]
; Fixed forever: Inno recognises an existing install by this, which is what
; makes upgrades replace in place instead of installing a second copy.
AppId={{7B1B3E2A-9C4D-4F2E-A6D1-2E5C9F0B4A17}
AppName=Necesse Server Manager (daemon)
AppVersion={#AppVersion}
AppPublisher=Jeff Pegg
DefaultDirName={autopf}\Necesse Server Manager
DefaultGroupName=Necesse Server Manager
DisableProgramGroupPage=yes
; The scheduled task and the firewall rule both need elevation, and so does
; writing to Program Files. Asking once up front beats failing halfway.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=necesse-daemon-v{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Necesse Server Manager (daemon)

[Dirs]
; Created so the Start Menu "Open state folder" shortcut is valid before the
; daemon has ever run. An empty directory here is safe: the legacy-state check
; treats a state directory as populated only when it actually contains
; something, so this cannot make a pre-migration install look migrated.
Name: "{commonappdata}\NecesseServerManager"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Setup (configure the daemon)"; Filename: "{app}\setup.cmd"
Name: "{group}\Start daemon"; Filename: "{app}\start-daemon.cmd"
Name: "{group}\Register boot task"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\register-task.ps1"""
Name: "{group}\Open state folder"; Filename: "{commonappdata}\NecesseServerManager"

[Tasks]
Name: "runsetup"; Description: "Run the setup wizard now (opens a console window)"
Name: "boottask"; Description: "Start the daemon automatically at boot, and open its firewall port"

[Code]
const
  TaskName = 'NecesseDaemon';

function StateDir(): String;
begin
  Result := ExpandConstant('{commonappdata}\NecesseServerManager');
end;

function ConfigExists(): Boolean;
begin
  Result := FileExists(StateDir() + '\config.json');
end;

function ScheduledTaskExists(): Boolean;
var
  Code: Integer;
begin
  Result := Exec('schtasks.exe', '/query /tn "' + TaskName + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

// Stopping is not optional on an upgrade: node.exe cannot be overwritten while
// it is running, and a surviving process keeps the port, so the daemon that
// starts afterwards would die on EADDRINUSE while the old one kept answering.
procedure StopDaemonTask();
var
  Code: Integer;
begin
  if not ScheduledTaskExists() then Exit;
  Exec('schtasks.exe', '/end /tn "' + TaskName + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(3000);
end;

// The boot-task checkbox defaults to what the machine already has, not to a
// blanket yes. Someone who deliberately runs the daemon by hand should not
// acquire a boot task because they accepted a default on an upgrade screen.
procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpSelectTasks then
  begin
    if ConfigExists() then
      WizardSelectTasks('!runsetup')
    else
      WizardSelectTasks('runsetup');

    if ScheduledTaskExists() or (not ConfigExists()) then
      WizardSelectTasks('boottask')
    else
      WizardSelectTasks('!boottask');
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  RanSetup: Boolean;
begin
  if CurStep = ssInstall then
  begin
    StopDaemonTask();
  end
  else if CurStep = ssPostInstall then
  begin
    RanSetup := False;
    if WizardIsTaskSelected('runsetup') and (not ConfigExists()) then
    begin
      // Visible and waited on: the wizard is interactive and cannot be
      // scripted, so there is nothing to do but show it and let the operator
      // answer. Running it hidden would hang forever on the first prompt.
      Exec(ExpandConstant('{app}\setup.cmd'), '', ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code);
      RanSetup := True;
    end;

    // Ordering is load-bearing. Registering the task before a config exists
    // starts a daemon that refuses to boot, and register-task.ps1 ends with a
    // health check - so it would report failure on a registration that in fact
    // worked. Gate on the config actually being there now.
    if WizardIsTaskSelected('boottask') then
    begin
      if ConfigExists() then
      begin
        if not Exec('powershell.exe',
                    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\register-task.ps1') + '"',
                    ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code) or (Code <> 0) then
          MsgBox('The daemon was installed, but registering the boot task did not complete.' + #13#10#13#10 +
                 'You can retry it from the Start Menu (Register boot task). If the daemon refuses to start, it writes the reason to:' + #13#10 +
                 StateDir() + '\boot-refusal.txt',
                 mbError, MB_OK);
      end
      else if RanSetup then
        MsgBox('Setup did not finish, so no configuration was written and the boot task was not registered.' + #13#10#13#10 +
               'Run "Setup" from the Start Menu when you are ready, then "Register boot task".',
               mbInformation, MB_OK);
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Exec('schtasks.exe', '/end /tn "' + TaskName + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(2000);
    Exec('schtasks.exe', '/delete /tn "' + TaskName + '" /f', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Exec('netsh.exe', 'advfirewall firewall delete rule name="' + TaskName + '-Inbound"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    // Deliberately NOT deleted, and deliberately not offered as a checkbox.
    // mod-library\ is the only copy of every uploaded and hand-placed jar, and
    // uninstall is the screen people click through fastest.
    MsgBox('The daemon has been removed.' + #13#10#13#10 +
           'Your worlds are untouched, and your configuration and mod library were left in place at:' + #13#10 +
           StateDir() + #13#10#13#10 +
           'Delete that folder yourself if you want it gone. It holds the only copy of any mod jar you uploaded by hand.',
           mbInformation, MB_OK);
  end;
end;
```

- [ ] **Step 3: Compile it against the stage from Task 2**

```powershell
$stage = Join-Path $env:TEMP "stagetest"
$out = Join-Path $env:TEMP "issout"
New-Item -ItemType Directory -Force $out | Out-Null
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" "/DStageDir=$stage" "/DAppVersion=1.0.0" "/DOutDir=$out" installer\necesse-daemon.iss
"exit=$LASTEXITCODE"
Get-ChildItem $out
```

Expected: `exit=0` and `necesse-daemon-v1.0.0-setup.exe` present. If the stage from Task 2 is gone, re-create it with the two staging scripts first.

Two things that may need adjusting for the installed Inno version, both of which fail loudly at compile time rather than silently:

- `ArchitecturesAllowed=x64compatible` and `ArchitecturesInstallIn64BitMode=x64compatible` are Inno 6.3+ spellings. If ISCC rejects them, the installed Inno is older: use `x64` for both.
- `WizardSelectTasks` uses a `!` prefix to deselect. If ISCC accepts it but the defaults come out wrong, say so in the report rather than working around it — see the note below.

**Record this as a known gap:** the silent verification in Task 4 passes `/TASKS=""`, which overrides whatever the defaults were. So the `CurPageChanged` logic that sets those checkboxes from the machine's existing state is *not* covered by any automated check, and only a non-silent install would exercise it. Do not claim it works; note it as unverified.

- [ ] **Step 4: Commit**

```bash
git add installer/necesse-daemon.iss
git commit -m "feat(installer): Inno Setup script for the daemon"
```

---

### Task 4: End-to-end installer verification

**Files:**
- Create: `installer/verify-installer.ps1`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `installer/verify-installer.ps1` — builds a stage, compiles the installer, installs silently, proves the bundled runtime is genuinely used, uninstalls silently, and asserts the state directory survived.

- [ ] **Step 1: Write the verification script**

```powershell
$ErrorActionPreference = "Stop"
# Builds the installer and proves the claims that matter about it. Runs with
# /TASKS="" throughout, so it never registers a scheduled task or a firewall
# rule on the machine doing the testing.
$repo  = Split-Path -Parent $PSScriptRoot
$work  = Join-Path $env:TEMP ("instver-" + [guid]::NewGuid().ToString("N"))
$stage = Join-Path $work "stage"
$out   = Join-Path $work "out"
$dest  = Join-Path $work "app"
$state = Join-Path $work "state"
$iscc  = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
$fails = 0
function Check($n, $ok, $d) {
  if ($ok) { Write-Host "PASS  ${n}  ${d}" } else { Write-Host "FAIL  ${n}  ${d}"; $script:fails++ }
}

New-Item -ItemType Directory -Force $work, $out, $state | Out-Null

Push-Location (Join-Path $repo "daemon")
try { npm run build | Out-Host; if ($LASTEXITCODE -ne 0) { throw "daemon build failed" } } finally { Pop-Location }

pwsh -NoProfile -File (Join-Path $repo "installer\stage-daemon.ps1") -RepoRoot $repo -StageDir $stage | Out-Host
pwsh -NoProfile -File (Join-Path $repo "installer\fetch-node.ps1") -StageDir $stage -RepoRoot $repo | Out-Host
Check "stage has a bundled node" (Test-Path (Join-Path $stage "node\node.exe")) ""

& $iscc "/DStageDir=$stage" "/DAppVersion=0.0.0-test" "/DOutDir=$out" (Join-Path $repo "installer\necesse-daemon.iss") | Out-Host
$setup = Join-Path $out "necesse-daemon-v0.0.0-test-setup.exe"
Check "installer compiled" (Test-Path $setup) ""

# /TASKS="" deselects both post-install actions, so nothing interactive runs and
# no scheduled task is created on this machine.
$p = Start-Process -FilePath $setup -ArgumentList @("/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART","/DIR=$dest","/TASKS=""""") -Wait -PassThru
Check "silent install exit 0" ($p.ExitCode -eq 0) "exit=$($p.ExitCode)"
foreach ($f in @("dist\index.js","dist\setup-cli.js","dist\migrate-cli.js","node\node.exe","start-daemon.cmd","setup.cmd","migrate.cmd","register-task.ps1","config.example.json","package.json")) {
  Check "installed: $f" (Test-Path (Join-Path $dest $f)) ""
}
Check "node_modules installed" (Test-Path (Join-Path $dest "node_modules\fastify")) ""

# The bundled runtime must be what actually runs. With node stripped from PATH,
# an install that quietly depended on the system Node fails here - which is the
# entire point of bundling one.
$safePath = "C:\Windows\System32;C:\Windows"
$o = Join-Path $work "run.out"
$cmd = "set `"PATH=$safePath`" && set `"NECESSE_MANAGER_DATA=$state`" && `"$dest\start-daemon.cmd`""
& cmd /c $cmd > $o 2>&1
$runOut = Get-Content $o -Raw
Check "runs on the bundled node with no node on PATH" (-not ($runOut -match "not recognized|MODULE_NOT_FOUND")) ""
Check "and refuses cleanly, naming setup.cmd" ($runOut -match "setup\.cmd") ""

# State the uninstaller must not touch.
Set-Content -Path (Join-Path $state "config.json") -Value '{"port":8710}' -NoNewline
New-Item -ItemType Directory -Force (Join-Path $state "mod-library\abc") | Out-Null
Set-Content -Path (Join-Path $state "mod-library\abc\a.jar") -Value "JAR" -NoNewline

$unins = Join-Path $dest "unins000.exe"
Check "uninstaller present" (Test-Path $unins) ""
$u = Start-Process -FilePath $unins -ArgumentList @("/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART") -Wait -PassThru
Start-Sleep -Seconds 2
Check "silent uninstall exit 0" ($u.ExitCode -eq 0) "exit=$($u.ExitCode)"
Check "install directory removed" (-not (Test-Path (Join-Path $dest "dist\index.js"))) ""

# The assertion this whole script exists for.
Check "STATE DIRECTORY SURVIVED" (Test-Path (Join-Path $state "config.json")) ""
Check "MOD LIBRARY SURVIVED" ((Get-Content (Join-Path $state "mod-library\abc\a.jar") -Raw -ErrorAction SilentlyContinue) -eq "JAR") ""

Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "FAILURES: $fails"
if ($fails -gt 0) { exit 1 }
```

- [ ] **Step 2: Run it**

Run: `pwsh -NoProfile -File installer\verify-installer.ps1`
Expected: every check PASS, `FAILURES: 0`.

Note the script uses `NECESSE_MANAGER_DATA` to keep the daemon's state in the scratch directory, so the real `%PROGRAMDATA%\NecesseServerManager` on this machine is never read or written. Confirm that is true by checking the real state directory's contents are unchanged after the run.

- [ ] **Step 3: Prove the survival assertion can fail**

Temporarily add `Exec('cmd.exe', '/c rmdir /s /q "' + StateDir() + '"', ...)` to `CurUninstallStepChanged`'s `usUninstall` branch, re-run the verification, and confirm "STATE DIRECTORY SURVIVED" **FAILS**. Then remove that line and confirm the suite is green again. Put both outputs in the report. Without this, a passing assertion proves only that nothing happened to delete the directory, not that the check would notice if something did.

- [ ] **Step 4: Commit**

```bash
git add installer/verify-installer.ps1
git commit -m "test(installer): prove the bundled runtime is used and uninstall spares the state directory"
```

---

### Task 5: Wire the installer into CI and the release

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces: a fourth release asset, `necesse-daemon-v<tag>-setup.exe`.

- [ ] **Step 1: Add an installer-compile step to `ci.yml`**

Insert after the existing `Build daemon` step and before `Test daemon`:

```yaml
      # Compiling the installer against a real stage is what catches a missing
      # file, a wrong path or a bad define. A syntax-only check would not: the
      # commonest breakage here is [Files] pointing at something that is no
      # longer produced, and that only shows up when the payload is real.
      - name: Build the daemon installer
        shell: pwsh
        run: |
          $iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
          if (-not (Test-Path $iscc)) { choco install innosetup -y --no-progress }
          if (-not (Test-Path $iscc)) { throw "ISCC.exe not found at $iscc after installing Inno Setup." }
          pwsh -File installer/stage-daemon.ps1 -RepoRoot $PWD -StageDir "$env:RUNNER_TEMP\stage"
          pwsh -File installer/fetch-node.ps1 -StageDir "$env:RUNNER_TEMP\stage" -RepoRoot $PWD
          & $iscc "/DStageDir=$env:RUNNER_TEMP\stage" "/DAppVersion=0.0.0-ci" "/DOutDir=$env:RUNNER_TEMP\out" installer/necesse-daemon.iss
          if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit $LASTEXITCODE" }
          Get-ChildItem "$env:RUNNER_TEMP\out"
```

- [ ] **Step 2: Rework the release workflow's staging to use the shared scripts**

Replace the entire `Stage the daemon zip` step in `.github/workflows/release.yml` with:

```yaml
      - name: Stage the daemon zip
        shell: pwsh
        run: |
          pwsh -File installer/stage-daemon.ps1 -RepoRoot $PWD -StageDir "$PWD\staging\necesse-daemon"
          # Zipped BEFORE the Node runtime is added: the zip deliberately ships
          # without one and uses whatever Node the operator already has, which
          # is why the .cmd shims fall back to PATH. Staging once and zipping
          # first is what lets both artifacts come from one staging run.
          Compress-Archive -Path "staging/necesse-daemon/*" -DestinationPath "necesse-daemon-${{ github.ref_name }}.zip"

      - name: Build the daemon installer
        shell: pwsh
        run: |
          $iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
          if (-not (Test-Path $iscc)) { choco install innosetup -y --no-progress }
          if (-not (Test-Path $iscc)) { throw "ISCC.exe not found at $iscc after installing Inno Setup." }
          pwsh -File installer/fetch-node.ps1 -StageDir "$PWD\staging\necesse-daemon" -RepoRoot $PWD
          $version = "${{ github.ref_name }}".TrimStart("v")
          & $iscc "/DStageDir=$PWD\staging\necesse-daemon" "/DAppVersion=$version" "/DOutDir=$PWD" installer/necesse-daemon.iss
          if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit $LASTEXITCODE" }
          Get-ChildItem "necesse-daemon-*-setup.exe"
```

- [ ] **Step 3: Add the installer to the published assets**

In the `Publish release` step's `files:` block, add the installer line and update the body:

```yaml
          files: |
            necesse-daemon-${{ github.ref_name }}.zip
            necesse-daemon-*-setup.exe
            client/src-tauri/target/release/bundle/nsis/*.exe
            client/src-tauri/target/release/bundle/msi/*.msi
          body: |
            Two ways to install the daemon: run necesse-daemon-*-setup.exe, which
            brings its own Node and can register the boot task for you, or unzip
            necesse-daemon-*.zip and run setup.cmd yourself (that one needs Node 22+).

            Both installers are unsigned, so Windows SmartScreen will warn on first
            run. Choose "More info" then "Run anyway".

            Upgrading from an install that kept its state beside dist/: run
            migrate.cmd in that old folder once, before installing.
```

- [ ] **Step 4: Validate both workflows parse**

```powershell
python -c "import yaml;[yaml.safe_load(open(p,encoding='utf-8')) for p in ['.github/workflows/ci.yml','.github/workflows/release.yml']];print('ok')"
```

If PyYAML is unavailable, say so in the report rather than installing anything.

Neither workflow can be executed locally. State that plainly in the report.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "ci: build the daemon installer and publish it with the release"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md` — the "Install the daemon", "Open the port" and "Run it at boot" sections
- Modify: `CLAUDE.md` — the deploy/state section

- [ ] **Step 1: Rewrite the README's daemon install section**

Restructure "Install the daemon" into two clearly-labelled routes, installer first:

- **Installer (recommended).** Download `necesse-daemon-vX.Y.Z-setup.exe`, run it as Administrator. It brings its own Node, so nothing else is needed. It runs the setup wizard in a console window (answer the prompts, note the access token it prints), then registers the boot task and opens the firewall port if you left those boxes ticked. SmartScreen will warn because it is unsigned: "More info" then "Run anyway".
- **Zip.** Unchanged from today, and note explicitly that this route needs Node 22 or newer already installed.

Add to that section, plainly:

- Uninstalling removes the daemon, the scheduled task and the firewall rule, and **leaves your configuration and mod library** in `%PROGRAMDATA%\NecesseServerManager`. Delete that folder yourself if you want it gone; it holds the only copy of any jar you uploaded by hand.
- Upgrading with the installer keeps your configuration and your access token, and does not re-run the wizard.
- **If you previously used the zip and your `config.json` sits beside `dist\`**, run `migrate.cmd` in that old folder before installing, or the new install will look empty. The installer creates a fresh directory and cannot find your old one.

Update "Open the port" to say the installer's boot-task option creates the firewall rule, so only the zip route needs it done by hand.

House style is binding here: no em dashes or en dashes, no curly quotes, plain ASCII, and none of "leverage", "robust", "seamlessly", "comprehensive".

- [ ] **Step 2: Add a line to `CLAUDE.md`**

In the section covering the state directory and deployment, add that the daemon now ships two artifacts, that the installer bundles a private Node at `<install dir>\node\node.exe` which the `.cmd` shims and `register-task.ps1` prefer over `PATH`, and that the pinned Node version lives in `installer/node-version.txt` and is the one place to change it.

- [ ] **Step 3: Verify no claim in the README is false**

Re-read the rewritten section against the actual `.iss` and the shims. Every sentence describing what the installer does must match what the code does. Specifically confirm: the wizard is skipped when a config already exists, the boot task checkbox defaults to what the machine already has, and uninstall really does not touch the state directory.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document the daemon installer and what uninstall leaves behind"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full suite and typecheck**

From `daemon/`: `npx vitest run; "EXIT=$LASTEXITCODE"` then `npx tsc --noEmit; "EXIT=$LASTEXITCODE"`
From `client/`: the same.
Expected: `EXIT=0` four times.

- [ ] **Step 2: Both installer verification scripts**

```powershell
pwsh -NoProfile -File installer\verify-shims.ps1
pwsh -NoProfile -File installer\verify-installer.ps1
```
Expected: `FAILURES: 0` from both.

- [ ] **Step 3: Confirm the real state directory was untouched**

```powershell
Get-ChildItem "$env:PROGRAMDATA\NecesseServerManager" -ErrorAction SilentlyContinue | Select-Object Name, LastWriteTime
```
The verification scripts redirect state to scratch directories; confirm nothing here changed during this work.

- [ ] **Step 4: Write the verification record**

Create `docs/verification-2026-07-30-installer.md` in the style of the existing `docs/verification-*.md` files. Record what was run with real output, and state explicitly what was **not**: neither workflow ran on GitHub, the installer was never run non-silently so the interactive wizard launch and the real task registration are unexercised, no upgrade-over-a-previous-version was tested, and nothing was installed on the live server.

- [ ] **Step 5: Commit**

```bash
git add docs/verification-2026-07-30-installer.md
git commit -m "docs: verification record for the daemon installer"
```

---

## Self-Review

**Spec coverage:** §3 layout → Tasks 2, 3. §4 shims and task → Task 1. §5 install sequence → Task 3. §6 upgrade → Task 3 (`CurPageChanged`, `StopDaemonTask`, config-exists skip). §7 uninstall → Task 3 (`CurUninstallStepChanged`) and Task 4 (the assertion). §8 build and release → Tasks 2, 5. §9 verification → Tasks 1, 4, 7. §10 out of scope → nothing implemented.

**Known gaps, stated rather than hidden:** neither workflow can run locally; the interactive wizard launch and real task registration are only exercised by a non-silent install, which this plan does not perform; an upgrade over a previously-installed version is not covered by the silent verification and would need two sequential installs to test properly.
