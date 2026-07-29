$ErrorActionPreference = "Stop"

$local = Join-Path $PSScriptRoot "deploy.local.ps1"
if (-not (Test-Path $local)) {
  throw "No $local. Copy deploy.local.ps1.example to deploy.local.ps1 and fill in your own values."
}
. $local
$remote = "$RemoteUser@$RemoteHost"
$key    = $SshKey

# There is no Restart-ScheduledTask cmdlet on SERVER's PowerShell 5.1, so the
# restart is Stop + wait-for-exit + Start. The wait matters: Start-ScheduledTask
# on a task that is still terminating is a no-op, which silently leaves the OLD
# daemon build serving the port while every subsequent check appears to pass.
#
# Every failure below throws rather than printing. A restart that half-worked
# and still exited 0 is precisely the outcome this script exists to prevent,
# and relying on a human to notice "STILL_RUNNING" in stdout is not a check.
#
# $TaskName/$DaemonPort come from deploy.local.ps1 and must be interpolated
# here on the workstation -- everything else in this here-string is a variable
# that only exists on SERVER once the script runs there, so it is escaped with
# a backtick to survive interpolation untouched.
$script = @"
`$ErrorActionPreference = "Stop"
Stop-ScheduledTask -TaskName "$TaskName"
`$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt `$deadline) {
  if ((Get-ScheduledTask -TaskName "$TaskName").State -ne 'Running') { break }
  Start-Sleep -Milliseconds 500
}
`$stopped = (Get-ScheduledTask -TaskName "$TaskName").State
if (`$stopped -eq 'Running') {
  throw "$TaskName still Running 20s after Stop-ScheduledTask. Start-ScheduledTask would be a silent no-op here and leave the old build serving the port, so this aborts rather than report a restart that did not happen."
}
Write-Output "STOPPED_STATE=`$stopped"
Start-ScheduledTask -TaskName "$TaskName"
Start-Sleep -Seconds 4
`$started = (Get-ScheduledTask -TaskName "$TaskName").State
if (`$started -ne 'Running') {
  throw "$TaskName did not reach Running after Start-ScheduledTask (state: `$started)."
}
Write-Output "STARTED_STATE=`$started"
`$status = Invoke-RestMethod http://localhost:$DaemonPort/api/status
if (`$null -eq `$status.activeTasks) {
  throw "GET /api/status carries no activeTasks field, so the daemon answering on the port is a pre-round-4 build and the restart did not pick up the new dist."
}
`$status | ConvertTo-Json -Compress
"@

$tmp = [System.IO.Path]::GetTempFileName() + ".ps1"
Set-Content -Path $tmp -Value $script -Encoding UTF8
try {
  scp -i $key $tmp "${remote}:C:/Users/$RemoteUser/_restart_daemon.ps1"
  if ($LASTEXITCODE -ne 0) { throw "scp of the restart script failed (exit $LASTEXITCODE)." }

  $out = ssh -i $key $remote "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\$RemoteUser\_restart_daemon.ps1"
  $code = $LASTEXITCODE
  Write-Output $out
  if ($code -ne 0) { throw "Remote restart failed (exit $code). See the output above." }
} finally {
  # GetTempFileName() creates its own 0-byte file, so the extensionless original
  # has to go too, along with the copy left behind on SERVER.
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Remove-Item ($tmp -replace '\.ps1$', '') -ErrorAction SilentlyContinue
  ssh -i $key $remote "del C:\Users\$RemoteUser\_restart_daemon.ps1" 2>$null | Out-Null
}
