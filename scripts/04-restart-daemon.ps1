$ErrorActionPreference = "Stop"
$key    = "$env:USERPROFILE\.ssh\necesse_server"
$remote = "jeffp@192.168.1.106"

# There is no Restart-ScheduledTask cmdlet on SERVER's PowerShell 5.1, so the
# restart is Stop + wait-for-exit + Start. The wait matters: Start-ScheduledTask
# on a task that is still terminating is a no-op, which silently leaves the OLD
# daemon build serving :8710 while every subsequent check appears to pass.
#
# Every failure below throws rather than printing. A restart that half-worked
# and still exited 0 is precisely the outcome this script exists to prevent,
# and relying on a human to notice "STILL_RUNNING" in stdout is not a check.
$script = @'
$ErrorActionPreference = "Stop"
Stop-ScheduledTask -TaskName NecesseDaemon
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  if ((Get-ScheduledTask -TaskName NecesseDaemon).State -ne 'Running') { break }
  Start-Sleep -Milliseconds 500
}
$stopped = (Get-ScheduledTask -TaskName NecesseDaemon).State
if ($stopped -eq 'Running') {
  throw "NecesseDaemon still Running 20s after Stop-ScheduledTask. Start-ScheduledTask would be a silent no-op here and leave the old build serving :8710, so this aborts rather than report a restart that did not happen."
}
Write-Output "STOPPED_STATE=$stopped"
Start-ScheduledTask -TaskName NecesseDaemon
Start-Sleep -Seconds 4
$started = (Get-ScheduledTask -TaskName NecesseDaemon).State
if ($started -ne 'Running') {
  throw "NecesseDaemon did not reach Running after Start-ScheduledTask (state: $started)."
}
Write-Output "STARTED_STATE=$started"
$status = Invoke-RestMethod http://localhost:8710/api/status
if ($null -eq $status.activeTasks) {
  throw "GET /api/status carries no activeTasks field, so the daemon answering on :8710 is a pre-round-4 build and the restart did not pick up the new dist."
}
$status | ConvertTo-Json -Compress
'@

$tmp = [System.IO.Path]::GetTempFileName() + ".ps1"
Set-Content -Path $tmp -Value $script -Encoding UTF8
try {
  scp -i $key $tmp "${remote}:C:/Users/jeffp/_restart_daemon.ps1"
  if ($LASTEXITCODE -ne 0) { throw "scp of the restart script failed (exit $LASTEXITCODE)." }

  $out = ssh -i $key $remote "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\jeffp\_restart_daemon.ps1"
  $code = $LASTEXITCODE
  Write-Output $out
  if ($code -ne 0) { throw "Remote restart failed (exit $code). See the output above." }
} finally {
  # GetTempFileName() creates its own 0-byte file, so the extensionless original
  # has to go too, along with the copy left behind on SERVER.
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Remove-Item ($tmp -replace '\.ps1$', '') -ErrorAction SilentlyContinue
  ssh -i $key $remote "del C:\Users\jeffp\_restart_daemon.ps1" 2>$null | Out-Null
}
