$ErrorActionPreference = "Stop"
$key    = "$env:USERPROFILE\.ssh\necesse_server"
$repo   = Split-Path -Parent $PSScriptRoot
$remote = "jeffp@192.168.1.106"
$dest   = "C:\Users\jeffp\necesse-daemon"
$destFwd = "C:/Users/jeffp/necesse-daemon"

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
    scp -i $key $tmp "${remote}:C:/Users/jeffp/_deploy_step.ps1"
    if ($LASTEXITCODE -ne 0) { throw "scp of deploy step failed" }
    $out = ssh -i $key $remote "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\jeffp\_deploy_step.ps1"
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
  npx tsc
  if ($LASTEXITCODE -ne 0) { throw "tsc build failed" }
} finally {
  Pop-Location
}

Invoke-RemoteScript "New-Item -ItemType Directory -Force '$dest' | Out-Null; Write-Output 'DIR_OK'" | Out-Null

scp -i $key -r "$repo\daemon\dist"              "${remote}:$destFwd/"
scp -i $key    "$repo\daemon\package.json"      "${remote}:$destFwd/"
scp -i $key    "$repo\daemon\package-lock.json" "${remote}:$destFwd/"

# Seed config.json/mods.json only if absent -- never clobber live state.
# Clobbering mods.json would destroy the record of which jar belongs to
# which workshop id.
$state = Invoke-RemoteScript @"
if (Test-Path '$dest\config.json') { Write-Output 'CONFIG_EXISTS' } else { Write-Output 'CONFIG_MISSING' }
if (Test-Path '$dest\mods.json')   { Write-Output 'MODS_EXISTS' }   else { Write-Output 'MODS_MISSING' }
"@

if ($state -match "CONFIG_MISSING") {
  scp -i $key "$repo\scripts\seed\config.json" "${remote}:$destFwd/config.json"
  Write-Host "Seeded config.json (none existed on SERVER)."
} else {
  Write-Host "config.json already exists on SERVER -- left untouched."
}

if ($state -match "MODS_MISSING") {
  scp -i $key "$repo\scripts\seed\mods.json" "${remote}:$destFwd/mods.json"
  Write-Host "Seeded mods.json (none existed on SERVER)."
} else {
  Write-Host "mods.json already exists on SERVER -- left untouched."
}

Invoke-RemoteScript @"
Set-Location '$dest'
npm ci --omit=dev
if (`$LASTEXITCODE -ne 0) { throw "npm ci --omit=dev failed with exit `$LASTEXITCODE" }
Write-Output 'INSTALL_OK'
"@

Write-Host "Deployed."
