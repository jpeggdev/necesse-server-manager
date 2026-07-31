[CmdletBinding()]
param(
  [ValidateSet('Check', 'Stop')]
  [string]$Mode = 'Check'
)
$ErrorActionPreference = "Stop"

# Runs on the INSTALLING machine, not SERVER, and PowerShell 5.1 is the floor
# to target there -- no -SkipHttpErrorCheck (pwsh 7 only, see the reference
# note in CLAUDE.md's pwsh7-gotchas memory). Mirrors the config read in
# scripts/03-register-task.ps1: same BOM strip, same "never abort on a
# malformed file" contract, because a hand-edited config.json is a realistic
# state here too, not a hypothetical one.
$TaskName = 'NecesseDaemon'
$configFile = Join-Path $env:PROGRAMDATA "NecesseServerManager\config.json"

function Read-DaemonConfig {
  if (-not (Test-Path $configFile)) { return $null }
  try {
    return ((Get-Content $configFile -Raw) -replace "^\uFEFF", "") | ConvertFrom-Json
  } catch {
    return $_.Exception.Message
  }
}

function Get-DaemonPort($cfg) {
  if ($cfg -and $cfg.port) { return [int]$cfg.port }
  return 8710
}

if ($Mode -eq 'Check') {
  # Exit codes are the installer's contract (necesse-daemon.iss branches on
  # them): 0 = safe to proceed, 2 = a session may be live, 3 = could not tell.
  $cfg = Read-DaemonConfig
  if ($null -eq $cfg) {
    Write-Output "STATE=none (no config.json at $configFile)"
    exit 0
  }
  if ($cfg -is [string]) {
    Write-Output "CANNOT_DETERMINE: could not parse $configFile ($cfg)"
    exit 3
  }

  $port = Get-DaemonPort $cfg
  $headers = @{}
  if ($cfg.authToken) { $headers["Authorization"] = "Bearer $($cfg.authToken)" }

  try {
    $status = Invoke-RestMethod "http://localhost:$port/api/status" -Headers $headers -TimeoutSec 10
  } catch {
    # Not a typed catch, matching 03-register-task.ps1: which exception type
    # Invoke-RestMethod wraps a connection failure in differs across
    # PowerShell versions. A refused connection means nothing is listening --
    # that is a "nothing running" result, not a failure to determine.
    $refused = $false
    $ex = $_.Exception
    while ($ex) {
      if ($ex.Message -match 'actively refused' -or $ex.Message -match 'No connection could be made' -or $ex.GetType().Name -eq 'SocketException') {
        $refused = $true
        break
      }
      $ex = $ex.InnerException
    }
    if ($refused) {
      Write-Output "STATE=none (nothing answering on port $port)"
      exit 0
    }
    Write-Output "CANNOT_DETERMINE: GET http://localhost:$port/api/status failed: $($_.Exception.Message)"
    exit 3
  }

  if ($status.state -eq 'stopped') {
    Write-Output "STATE=stopped"
    exit 0
  }

  $world = $status.world
  if (-not $world) { $world = '(none)' }
  Write-Output "STATE=$($status.state) WORLD=$world"
  exit 2
}

if ($Mode -eq 'Stop') {
  # Called only after Check mode (or an operator override) has already
  # established it is safe to do this. Polls the way
  # scripts/03-register-task.ps1 already does -- task state up to 20s, then
  # the port up to 15s -- instead of a fixed sleep, because a fixed sleep
  # proves nothing about whether node.exe actually released the port or the
  # files it has open.
  $cfg = Read-DaemonConfig
  $port = 8710
  if ($cfg -and ($cfg -isnot [string])) { $port = Get-DaemonPort $cfg }

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
      $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      if (-not $t -or $t.State -ne 'Running') { break }
      Start-Sleep -Milliseconds 500
    }
  }

  # The task ending (or never having existed) does not by itself free the
  # port: the process it launched may still be winding down, and a daemon
  # started by hand from the "Start daemon" Start Menu shortcut was never
  # under the task at all. Either way, what actually blocks install and
  # uninstall is whatever still owns the port, so poll for that directly.
  $portDeadline = (Get-Date).AddSeconds(15)
  $conn = $null
  while ((Get-Date) -lt $portDeadline) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) { break }
    Start-Sleep -Milliseconds 500
  }

  if ($conn) {
    # Check mode has already established (or the operator has already
    # confirmed, via the installer's prompt) that no game session is live, so
    # the only thing left holding this port is the daemon's own supervisor
    # process. It installs no signal handler, so there is no graceful request
    # left to make -- end it directly rather than wait forever.
    foreach ($c in @($conn)) {
      $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -eq 'node') {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Milliseconds 500
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  }

  if ($conn) {
    Write-Output "STILL_LISTENING: port $port is still held after stop attempts."
    exit 1
  }
  Write-Output "STOPPED: port $port is free."
  exit 0
}
