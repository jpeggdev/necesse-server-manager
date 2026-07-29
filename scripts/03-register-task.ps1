$ErrorActionPreference = "Stop"

# Runs ON SERVER, so it reads deploy.local.ps1 from its own directory there --
# the same file 02-deploy.ps1 reads on the workstation, just a different copy
# (02-deploy.ps1 does not ship one; an operator who wants this to override the
# defaults below copies deploy.local.ps1.example next to this script on
# SERVER and fills it in, same as on the workstation).
# $InstallDir falls back to $PSScriptRoot when that file is absent or does not
# set it: on SERVER this script is meant to be run from inside the install
# directory itself (see setup-cli.ts's pointer to "register-task.ps1 at the
# root of a release download"), so the directory it is sitting in already is
# the install directory. Only throw if even that cannot be resolved.
# $DaemonPort/$TaskName fall back to their previous hardcoded defaults so a
# server that was already deployed before deploy.local.ps1 existed keeps
# registering the exact same task it always did.
$local = Join-Path $PSScriptRoot "deploy.local.ps1"
if (Test-Path $local) { . $local }
if (-not $InstallDir) { $InstallDir = $PSScriptRoot }
if (-not $InstallDir) { throw "Could not determine the install directory: `$PSScriptRoot is empty and no deploy.local.ps1 (next to this script) sets `$InstallDir." }
if (-not $TaskName)   { $TaskName = "NecesseDaemon" }
$dir = $InstallDir

# The daemon's own config.json is the authority on which port it will bind and
# which token it will demand. Both are read here rather than assumed: the
# firewall rule below opens ONE port, and a user who answered anything but 8710
# in setup.cmd would otherwise get a rule for a port nothing is listening on
# and a LAN client that cannot connect for a reason nothing reports.
$configFile = Join-Path $env:PROGRAMDATA "NecesseServerManager\config.json"
$configuredToken = $null
if (Test-Path $configFile) {
  # -Raw plus an explicit BOM strip: PowerShell 5.1's Set-Content -Encoding UTF8
  # writes one and ConvertFrom-Json rejects it, and hand-editing this file is
  # the documented way to set the Steam key -- which also means a trailing
  # comma or stray character here is a realistic state, not a hypothetical
  # one. This read must never abort registration: fall through to no token
  # rather than let a malformed config.json stop the task from ever being
  # created.
  try {
    $daemonConfig = ((Get-Content $configFile -Raw) -replace "^\uFEFF", "") | ConvertFrom-Json
    if (-not $DaemonPort -and $daemonConfig.port) { $DaemonPort = [int]$daemonConfig.port }
    $configuredToken = $daemonConfig.authToken
  } catch {
    Write-Output "WARNING: could not read/parse $configFile ($($_.Exception.Message)); the health check below will be attempted unauthenticated."
  }
}
if (-not $DaemonPort) { $DaemonPort = 8710 }
# The firewall rule id and the Scheduled Task name are deliberately separate
# variables even though they default from the same value: they are different
# namespaces (netsh vs. Task Scheduler), and an instruction to rename or
# delete "the task" should not also silently rename or orphan the firewall
# rule, or vice versa.
$firewallRuleName = "$TaskName-Inbound"

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

New-NetFirewallRule -Name $firewallRuleName -DisplayName "Necesse Daemon ($DaemonPort)" `
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

# Authenticated, because setup.cmd ALWAYS generates a token: an unauthenticated
# check here answers 401 for every user who followed the README's install step,
# and Invoke-RestMethod throws terminating on a 4xx in PowerShell 5.1 -- so the
# documented "run it at boot" step ended with a stack trace on a registration
# that had in fact worked perfectly.
$headers = @{}
if ($configuredToken) { $headers["Authorization"] = "Bearer $configuredToken" }
try {
  Invoke-RestMethod "http://localhost:$DaemonPort/api/status" -Headers $headers | ConvertTo-Json -Compress
} catch {
  # Not a typed catch: which exception Invoke-RestMethod wraps a 4xx in has
  # changed across PowerShell versions, and a typed catch that misses puts the
  # operator back in front of the stack trace this exists to replace.
  $code = 0
  $resp = $_.Exception.PSObject.Properties['Response']
  if ($resp -and $resp.Value) { $code = [int]$resp.Value.StatusCode }
  if ($code -eq 401) {
    throw "The task is registered and the daemon is answering on port $DaemonPort, so registration succeeded. It rejected this check's token: this script read authToken from $configFile, and that is not the value the daemon booted with -- config.json was edited since it started, or the daemon is using a different state directory (NECESSE_MANAGER_DATA)."
  }
  throw "The task is registered, but GET http://localhost:$DaemonPort/api/status failed: $($_.Exception.Message). If the daemon refuses to boot it says why in $env:PROGRAMDATA\NecesseServerManager\boot-refusal.txt."
}
