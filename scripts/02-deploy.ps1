$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

$local = Join-Path $PSScriptRoot "deploy.local.ps1"
if (-not (Test-Path $local)) {
  throw "No $local. Copy deploy.local.ps1.example to deploy.local.ps1 and fill in your own values."
}
. $local
$remote  = "$RemoteUser@$RemoteHost"
$key     = $SshKey
$dest    = $InstallDir
$destFwd = $InstallDir -replace '\\', '/'

# The remote default shell is cmd.exe, not PowerShell -- so every remote
# action here is written to a temp .ps1, scp'd over, and run with
# `-File`. An inline `powershell -Command "... | Out-Null"` would have its
# `|` parsed by cmd.exe BEFORE powershell ever sees it, piping powershell's
# stdout into a literal "Out-Null.exe" that cmd.exe can't find.
function Invoke-RemoteScript {
  param([string]$Content)
  $tmp = [System.IO.Path]::GetTempFileName() + ".ps1"
  Set-Content -Path $tmp -Value $Content -Encoding UTF8
  try {
    scp -i $key $tmp "${remote}:C:/Users/$RemoteUser/_deploy_step.ps1"
    if ($LASTEXITCODE -ne 0) { throw "scp of deploy step failed" }
    $out = ssh -i $key $remote "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\$RemoteUser\_deploy_step.ps1"
    if ($LASTEXITCODE -ne 0) { throw "remote step failed (exit $LASTEXITCODE):`n$out" }
    return $out
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}

# $InstallDir and the Scheduled Task have to be talking about the same copy of
# the daemon. This box has had two -- a source deploy under the user profile
# and an Inno install under Program Files -- and deploying to the one the task
# does not run is a total no-op that reports success at every step: every file
# copies, npm ci succeeds, 04-restart-daemon.ps1 restarts the task, and its
# health check passes because a daemon IS answering on the port. Just the old
# one, from the other directory. The only symptom is that the new behaviour is
# missing, which is indistinguishable from having built it wrong.
#
# Checked before npm ci and tsc so a mismatch costs a round trip rather than a
# build, and before anything is copied so a refused deploy has written nothing.
function ConvertTo-ComparablePath([string]$p) {
  return ($p -replace '"', '').Trim().TrimEnd('\', '/')
}

$taskProbe = @(Invoke-RemoteScript @"
`$t = `$null
# -ErrorAction Stop inside a try, not SilentlyContinue: a missing task is an
# answer this script wants ("first deploy"), not an error to swallow, and
# SilentlyContinue would still leave the remote exit code nonzero.
try { `$t = Get-ScheduledTask -TaskName "$TaskName" -ErrorAction Stop } catch {}
if (`$null -eq `$t) { Write-Output "TASK_MISSING"; exit 0 }
# @() before indexing: a task with one action hands back a scalar, and
# indexing that gives a character.
`$a = @(`$t.Actions)[0]
`$dir = `$a.WorkingDirectory
if (-not `$dir) { `$dir = Split-Path -Parent `$a.Execute }
Write-Output "TASK_DIR=`$dir"
"@)

if ($taskProbe -contains "TASK_MISSING") {
  Write-Host "No Scheduled Task named '$TaskName' on $RemoteHost yet. Deploying, then run register-task.cmd there."
} else {
  $line = @($taskProbe | Where-Object { $_ -like "TASK_DIR=*" })[0]
  if ($null -eq $line) {
    throw "Could not read what Scheduled Task '$TaskName' runs on $RemoteHost. Refusing to deploy rather than copy into a directory that may not be the one that runs:`n$($taskProbe -join "`n")"
  }
  $taskDir = ConvertTo-ComparablePath ($line -replace '^TASK_DIR=', '')
  if (-not [string]::Equals($taskDir, (ConvertTo-ComparablePath $dest), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw @"
Scheduled Task '$TaskName' runs the daemon from:
    $taskDir
but this deploy would write to `$InstallDir:
    $dest

Nothing has been copied. Deploying to a directory the task does not run
succeeds at every step and changes nothing, so this refuses instead.

Fix whichever is stale:
  - the install moved (a zip install replaced by the Inno installer, or the
    reverse): point `$InstallDir in scripts\deploy.local.ps1 at the path above;
  - the task is stale: re-register it from this install by running
    register-task.cmd in $dest on $RemoteHost.
An install under Program Files is the installer's, and an scp as $RemoteUser
cannot write there -- upgrade that one by running the installer, not by
repointing this script.
"@
  }
}

Push-Location "$repo\daemon"
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
  # tsconfig.json is the typecheck config (src + test, noEmit); the emitting
  # one is tsconfig.build.json. A bare `npx tsc` here would emit nothing.
  npx tsc -p tsconfig.build.json
  if ($LASTEXITCODE -ne 0) { throw "tsc build failed" }
} finally {
  Pop-Location
}

Invoke-RemoteScript "New-Item -ItemType Directory -Force '$dest' | Out-Null; Write-Output 'DIR_OK'" | Out-Null

scp -i $key -r "$repo\daemon\dist"              "${remote}:$destFwd/"
scp -i $key    "$repo\daemon\package.json"      "${remote}:$destFwd/"
scp -i $key    "$repo\daemon\package-lock.json" "${remote}:$destFwd/"

# The launchers ship too. Without them the daemon's own boot refusal ("Run
# migrate.cmd from the install folder") names a file that is not on the server,
# and neither is setup.cmd, which is what the refusal for a missing config.json
# names, and neither is register-task.cmd, which is what the setup wizard's
# closing message names. A release zip carries all four; a deploy that did not
# was the only way to end up with an install where the printed instructions
# cannot be followed.
scp -i $key    "$repo\daemon\migrate.cmd"       "${remote}:$destFwd/"
scp -i $key    "$repo\daemon\setup.cmd"         "${remote}:$destFwd/"
scp -i $key    "$repo\daemon\start-daemon.cmd"  "${remote}:$destFwd/"
scp -i $key    "$repo\daemon\register-task.cmd" "${remote}:$destFwd/"
# register-task.cmd's line 55 runs "%~dp0register-task.ps1" -- shipping the
# .cmd without it is the same dead end this whole comment is about, just
# louder: it self-elevates, prompts for UAC, then dies on the missing file
# instead of failing before asking. Renamed on the way over for the same
# reason installer/stage-daemon.ps1 renames it: the setup wizard's closing
# message and register-task.cmd both name it "register-task.ps1", not
# "03-register-task.ps1".
scp -i $key    "$repo\scripts\03-register-task.ps1" "${remote}:$destFwd/register-task.ps1"

# Nothing is seeded into $dest. State (config.json, mods.json, the mod
# library, mod-sets.json) lives in the daemon's state directory, not beside
# dist/ -- see CLAUDE.md. mods.json is also one of LEGACY_STATE_FILES: writing
# it here would make a fresh install look like a pre-migration one and refuse
# to boot demanding migrate.cmd, even though nothing was ever migrated. The
# daemon creates it on first mod install; ModRegistry.load() treats a missing
# file as zero mods, not an error.

Invoke-RemoteScript @"
Set-Location '$dest'
npm ci --omit=dev
if (`$LASTEXITCODE -ne 0) { throw "npm ci --omit=dev failed with exit `$LASTEXITCODE" }
Write-Output 'INSTALL_OK'
"@

Write-Host "Deployed."
