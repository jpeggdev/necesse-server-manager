$ErrorActionPreference = "Stop"

# Runs ON SERVER, so it reads deploy.local.ps1 from its own directory there --
# the same file 02-deploy.ps1 reads on the workstation, just a different copy.
# $InstallDir must come from that file; there is no safe default for "where is
# the daemon" and guessing wrong would register a task pointed at nothing.
# $DaemonPort/$TaskName fall back to their previous defaults so a server that
# was already deployed before deploy.local.ps1 existed keeps working.
$local = Join-Path $PSScriptRoot "deploy.local.ps1"
if (Test-Path $local) { . $local }
if (-not $InstallDir) { throw "InstallDir could not be determined. Copy deploy.local.ps1.example to deploy.local.ps1 (in this script's directory) and set InstallDir." }
if (-not $DaemonPort) { $DaemonPort = 8710 }
if (-not $TaskName)   { $TaskName = "NecesseDaemon" }
$dir = $InstallDir

# Safe to re-run: -Force below replaces the existing task registration in
# place rather than adding a second one.
#
# AtStartup as SYSTEM, not AtLogOn as the interactive user. The old trigger
# only fired on interactive logon, so an unattended reboot left the box with
# no daemon and no game server. Autologon is not available to fix that on a
# box logging in with a Microsoft account (PrincipalSource=MicrosoftAccount),
# which Windows pushes to Hello/PIN, and a stored password is the thing this
# arrangement exists to avoid. SYSTEM starts with the machine, needs no
# password, and cannot expire.
#
# What used to make SYSTEM wrong was that the game derived its saves and mods
# from the running account's APPDATA: as SYSTEM that is
# C:\Windows\system32\config\systemprofile\AppData\Roaming\Necesse, so the
# server would come up with zero worlds and zero mods and call it a success.
# The daemon now passes -datadir explicitly (config.json `dataDir`), so the
# game's data directory no longer depends on who launched it. SYSTEM has
# FullControl on the daemon directory, the worlds and the mods folder, verified
# on this box by a probe task before this change was made.

New-NetFirewallRule -Name $TaskName -DisplayName "Necesse Daemon ($DaemonPort)" `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort $DaemonPort `
  -ErrorAction SilentlyContinue

$node = $null
try { $node = (Get-Command node.exe -ErrorAction Stop).Source } catch {}
if (-not $node) {
  # PATH may not be visible in this session yet (see 01-install-node.ps1's
  # note on sshd not picking up a machine-PATH change until restarted).
  $fallback = "C:\Program Files\nodejs\node.exe"
  if (Test-Path $fallback) { $node = $fallback }
}
if (-not $node) { throw "node.exe not found on PATH or at the default winget install location." }
# The task stores this path literally and SYSTEM's PATH is not the interactive
# user's, so a relative "node" would be resolved against the wrong environment
# at boot.
if (-not (Test-Path $node)) { throw "Resolved node.exe path does not exist: $node" }
if (-not (Test-Path $dir))  { throw "Daemon directory not found: $dir. Deploy before registering the task." }

# Stop a running instance before re-registering, and wait for it to actually
# exit. -Force replaces the registration but does not reliably take the running
# process with it, and a surviving node still holds the port -- the
# Start-ScheduledTask at the bottom would then launch a second daemon that dies
# on EADDRINUSE while the old build kept answering every check in this script.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  if ($existing.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    if ((Get-ScheduledTask -TaskName $TaskName).State -ne 'Running') { break }
    Start-Sleep -Milliseconds 500
  }
  if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') {
    throw "$TaskName is still Running 20s after Stop-ScheduledTask; refusing to re-register over a live daemon."
  }
  # The task can report not-Running while node is still winding down, and the
  # port goes with the process, not the task.
  $portDeadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $portDeadline) {
    if (-not (Get-NetTCPConnection -LocalPort $DaemonPort -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
}

$action = New-ScheduledTaskAction -Execute $node -Argument "dist\index.js" -WorkingDirectory $dir

# 30s after boot rather than at boot. The daemon binds its port as almost
# the first thing it does, and at the AtStartup instant the network stack is
# still coming up -- a bind that lands before the stack is ready fails outright
# and the task does not retry, which is the same dead box this change is meant
# to eliminate. The delay also lets the disk settle before the mod-library
# migration scans the worlds and mods folders. Nothing is waiting on the daemon
# 30 seconds into a boot: no player can connect until it has started a world,
# and starting a world is a manual action from the client.
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT30S"

# SYSTEM + ServiceAccount: no password stored, and no interactive session
# required. RunLevel Highest keeps the elevation the old registration had.
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# ExecutionTimeLimit Zero: the daemon is meant to run forever, and the default
# 3-day limit would terminate it. RestartCount/RestartInterval are new here --
# with no logged-on operator to notice, a daemon that dies at 4am must come back
# on its own.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force

# Prove the registration is what was asked for, rather than trusting -Force.
$task = Get-ScheduledTask -TaskName $TaskName
$who = $task.Principal.UserId
Write-Output "PRINCIPAL=$who RUNLEVEL=$($task.Principal.RunLevel) TRIGGER=$($task.Triggers[0].CimClass.CimClassName) DELAY=$($task.Triggers[0].Delay)"
if ($who -notmatch 'SYSTEM$') { throw "Task registered as '$who', not SYSTEM." }

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5
Invoke-RestMethod "http://localhost:$DaemonPort/api/status" | ConvertTo-Json -Compress
