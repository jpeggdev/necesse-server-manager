$ErrorActionPreference = "Stop"
$dir = "C:\Users\jeffp\necesse-daemon"

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

$action  = New-ScheduledTaskAction -Execute $node -Argument "dist\index.js" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "NecesseDaemon" -Action $action -Trigger $trigger `
  -Settings $settings -RunLevel Highest -Force
Start-ScheduledTask -TaskName "NecesseDaemon"
Start-Sleep -Seconds 3
Invoke-RestMethod http://localhost:8710/api/status | ConvertTo-Json
