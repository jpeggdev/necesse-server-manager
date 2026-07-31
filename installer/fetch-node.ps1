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
