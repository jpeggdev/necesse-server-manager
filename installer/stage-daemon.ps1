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
