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
