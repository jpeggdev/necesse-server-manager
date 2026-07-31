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
