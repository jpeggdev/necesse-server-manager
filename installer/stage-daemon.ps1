[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RepoRoot,
  [Parameter(Mandatory)][string]$StageDir
)
$ErrorActionPreference = "Stop"

# The daemon payload, identical to what the release zip contains. Shared by the
# release workflow, CI and the local installer verification so there is one
# definition of "what ships" rather than three that drift.

# Guard before the Remove-Item below: this now runs unattended from two
# GitHub Actions workflows, where -StageDir is composed from environment
# variables ($env:RUNNER_TEMP, $PWD) rather than typed by a person at a
# prompt. A blank value, a bare drive letter, or a path that resolves
# somewhere unexpected must refuse loudly instead of recursively deleting
# whatever it lands on.
$trimmedStageDir = $StageDir.Trim()
if ([string]::IsNullOrWhiteSpace($trimmedStageDir)) {
  throw "stage-daemon.ps1: -StageDir is empty or whitespace; refusing to delete anything."
}

$resolvedStageDir = [System.IO.Path]::GetFullPath($trimmedStageDir)
$driveRoot = [System.IO.Path]::GetPathRoot($resolvedStageDir)
if ($resolvedStageDir.TrimEnd('\', '/') -eq $driveRoot.TrimEnd('\', '/')) {
  throw "stage-daemon.ps1: -StageDir '$resolvedStageDir' is a drive root; refusing to delete it."
}

function Test-UnderRoot([string]$Candidate, [string]$Root) {
  if (-not $Root) { return $false }
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  return $Candidate.StartsWith($rootFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

# The three real call sites: CI stages under $env:RUNNER_TEMP, the release
# workflow stages under <repo>\staging, and verify-installer.ps1 stages under
# $env:TEMP. Anything else is not a root this script was written to expect.
$expectedRoots = @($env:TEMP, $env:TMP, $env:RUNNER_TEMP, (Join-Path $RepoRoot "staging"))
$isExpectedRoot = @($expectedRoots | Where-Object { Test-UnderRoot $resolvedStageDir $_ }).Count -gt 0
if (-not $isExpectedRoot) {
  throw ("stage-daemon.ps1: -StageDir '$resolvedStageDir' is not under a recognised temp directory " +
         "(`$env:TEMP, `$env:TMP, `$env:RUNNER_TEMP) or under '$RepoRoot\staging'; refusing to delete it.")
}

if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

Copy-Item -Recurse (Join-Path $RepoRoot "daemon\dist") (Join-Path $StageDir "dist")
Copy-Item (Join-Path $RepoRoot "daemon\package.json"),(Join-Path $RepoRoot "daemon\package-lock.json") $StageDir
Copy-Item (Join-Path $RepoRoot "daemon\setup.cmd"),(Join-Path $RepoRoot "daemon\start-daemon.cmd"),(Join-Path $RepoRoot "daemon\migrate.cmd") $StageDir
# register-task.cmd elevates and then runs register-task.ps1, which needs admin
# for both the SYSTEM-principal scheduled task and the firewall rule. The zip
# route wants it for the same reason the installer's Start Menu shortcut does.
Copy-Item (Join-Path $RepoRoot "daemon\register-task.cmd") $StageDir
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
