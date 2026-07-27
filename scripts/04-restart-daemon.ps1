$ErrorActionPreference = "Stop"
$key    = "$env:USERPROFILE\.ssh\necesse_server"
$remote = "jeffp@192.168.1.106"

# There is no Restart-ScheduledTask cmdlet on SERVER's PowerShell 5.1, so the
# restart is Stop + wait-for-exit + Start. The wait matters: Start-ScheduledTask
# on a task that is still terminating is a no-op, which silently leaves the OLD
# daemon build serving :8710.
$script = @'
Stop-ScheduledTask -TaskName NecesseDaemon
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $st = (Get-ScheduledTask -TaskName NecesseDaemon).State
  if ($st -ne 'Running') { break }
  Start-Sleep -Milliseconds 500
}
Write-Output "STOPPED_STATE=$((Get-ScheduledTask -TaskName NecesseDaemon).State)"
Start-ScheduledTask -TaskName NecesseDaemon
Start-Sleep -Seconds 4
Write-Output "STARTED_STATE=$((Get-ScheduledTask -TaskName NecesseDaemon).State)"
(Invoke-RestMethod http://localhost:8710/api/status) | ConvertTo-Json -Compress
'@

$tmp = [System.IO.Path]::GetTempFileName() + ".ps1"
Set-Content -Path $tmp -Value $script -Encoding UTF8
try {
  scp -i $key $tmp "${remote}:C:/Users/jeffp/_restart_daemon.ps1"
  if ($LASTEXITCODE -ne 0) { throw "scp failed" }
  ssh -i $key $remote "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\jeffp\_restart_daemon.ps1"
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}
