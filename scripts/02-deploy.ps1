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

# Seed mods.json only if absent -- never clobber live state. Clobbering it
# would destroy the record of which jar belongs to which workshop id.
$state = Invoke-RemoteScript "if (Test-Path '$dest\mods.json') { Write-Output 'MODS_EXISTS' } else { Write-Output 'MODS_MISSING' }"

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
