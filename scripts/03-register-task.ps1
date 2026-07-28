$ErrorActionPreference = "Stop"
$dir = "C:\Users\jeffp\necesse-daemon"

# Runs ON SERVER, elevated. Safe to re-run: -Force below replaces the existing
# NecesseDaemon registration in place rather than adding a second one.
#
# AtStartup as SYSTEM, not AtLogOn as jeffp. The old trigger only fired when
# jeffp logged in interactively, so an unattended reboot left the box with no
# daemon and no game server. Autologon is not available to fix that -- jeffp is
# a Microsoft account (PrincipalSource=MicrosoftAccount), which Windows pushes
# to Hello/PIN, and a stored password is the thing this arrangement exists to
# avoid. SYSTEM starts with the machine, needs no password, and cannot expire.
#
# What used to make SYSTEM wrong was that the game derived its saves and mods
# from the running account's APPDATA: as SYSTEM that is
# C:\Windows\system32\config\systemprofile\AppData\Roaming\Necesse, so the
# server would come up with zero worlds and zero mods and call it a success.
# The daemon now passes -datadir explicitly (config.json `dataDir`), so the
# game's data directory no longer depends on who launched it. SYSTEM has
# FullControl on the daemon directory, the worlds and the mods folder, verified
# on this box by a probe task before this change was made.

New-NetFirewallRule -Name necesse-daemon -DisplayName "Necesse Daemon (8710)" `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 8710 `
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
# The task stores this path literally and SYSTEM's PATH is not jeffp's, so a
# relative "node" would be resolved against the wrong environment at boot.
if (-not (Test-Path $node)) { throw "Resolved node.exe path does not exist: $node" }
if (-not (Test-Path $dir))  { throw "Daemon directory not found: $dir. Deploy before registering the task." }

$action = New-ScheduledTaskAction -Execute $node -Argument "dist\index.js" -WorkingDirectory $dir

# 30s after boot rather than at boot. The daemon binds 0.0.0.0:8710 as almost
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

Register-ScheduledTask -TaskName "NecesseDaemon" -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force

# Prove the registration is what was asked for, rather than trusting -Force.
$task = Get-ScheduledTask -TaskName "NecesseDaemon"
$who = $task.Principal.UserId
Write-Output "PRINCIPAL=$who RUNLEVEL=$($task.Principal.RunLevel) TRIGGER=$($task.Triggers[0].CimClass.CimClassName) DELAY=$($task.Triggers[0].Delay)"
if ($who -notmatch 'SYSTEM$') { throw "Task registered as '$who', not SYSTEM." }

Start-ScheduledTask -TaskName "NecesseDaemon"
Start-Sleep -Seconds 5
Invoke-RestMethod http://localhost:8710/api/status | ConvertTo-Json -Compress
