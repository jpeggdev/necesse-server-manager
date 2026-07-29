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

# The daemon refuses to boot on legacy state beside dist\ and on a broken
# config.json, and it says exactly what to do about each -- on stdout, which
# for a Scheduled Task goes nowhere. Without this, every one of those refusals
# reaches the operator as nothing but "the task did not reach Running".
# Running it once in the foreground here is safe precisely because it refuses:
# a daemon that would start is a daemon the task is about to start anyway, and
# this copy is killed the moment it stops printing.
function Show-DaemonRefusal {
  `$exe = `$null
  try { `$exe = (Get-Command node.exe -ErrorAction Stop).Source } catch {}
  if (-not `$exe -and (Test-Path "C:\Program Files\nodejs\node.exe")) { `$exe = "C:\Program Files\nodejs\node.exe" }
  if (-not `$exe) { Write-Output "(node.exe not found, cannot run the daemon in the foreground)"; return }
  `$entry = Join-Path "$InstallDir" "dist\index.js"
  if (-not (Test-Path `$entry)) { Write-Output "(no `$entry to run)"; return }
  Write-Output "--- running the daemon in the foreground to capture why it will not start ---"
  `$out = Join-Path `$env:TEMP "necesse-foreground.log"
  `$err = Join-Path `$env:TEMP "necesse-foreground.err.log"
  `$p = Start-Process -FilePath `$exe -ArgumentList "dist\index.js" -WorkingDirectory "$InstallDir" ``
    -NoNewWindow -PassThru -RedirectStandardOutput `$out -RedirectStandardError `$err
  # A daemon that is going to refuse has done so within a second or two; one
  # that is going to work would otherwise sit here holding the port forever.
  if (-not `$p.WaitForExit(15000)) { `$p.Kill(); Write-Output "(the daemon did not exit within 15s -- it did not refuse, so the failure is elsewhere)" }
  foreach (`$f in @(`$out, `$err)) {
    if (Test-Path `$f) { Get-Content `$f | ForEach-Object { Write-Output `$_ } }
  }
  `$log = Join-Path `$env:PROGRAMDATA "NecesseServerManager\boot-refusal.txt"
  if (Test-Path `$log) { Write-Output "--- `$log ---"; Get-Content `$log | ForEach-Object { Write-Output `$_ } }
  Write-Output "--- end foreground run ---"
}

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
  Show-DaemonRefusal
  throw "$TaskName did not reach Running after Start-ScheduledTask (state: `$started). See the foreground run above for the daemon's own explanation."
}
Write-Output "STARTED_STATE=`$started"

# The daemon 401s an unauthenticated request whenever a token is configured,
# and setup.cmd always configures one, so the token has to be read back out of
# config.json. Invoke-RestMethod throws terminating on any 4xx in PowerShell
# 5.1, so without this the last line of a perfectly successful restart is a
# stack trace.
`$configFile = Join-Path `$env:PROGRAMDATA "NecesseServerManager\config.json"
`$headers = @{}
if (Test-Path `$configFile) {
  # -Raw plus an explicit BOM strip: Set-Content -Encoding UTF8 on 5.1 writes
  # one, and ConvertFrom-Json rejects it. Hand-editing this file is the
  # documented way to set the Steam key, so a malformed config.json here is
  # realistic -- and this fires AFTER a restart that already succeeded, so it
  # must never turn that success into a reported failure. Fall through to no
  # token rather than throw.
  try {
    `$raw = (Get-Content `$configFile -Raw) -replace "^\uFEFF", ""
    `$token = (`$raw | ConvertFrom-Json).authToken
    if (`$token) { `$headers["Authorization"] = "Bearer `$token" }
  } catch {
    Write-Output "WARNING: could not read/parse `$configFile (`$(`$_.Exception.Message)); the health check below will be attempted unauthenticated."
  }
}
try {
  `$status = Invoke-RestMethod "http://localhost:$DaemonPort/api/status" -Headers `$headers
} catch {
  # Not `catch [System.Net.WebException]`: the exact exception type Invoke-RestMethod
  # wraps a 4xx in has changed across PowerShell versions, and a typed catch that
  # misses puts the operator back where this started -- a stack trace instead of
  # a sentence. The status code is read defensively for the same reason.
  `$code = 0
  `$resp = `$_.Exception.PSObject.Properties['Response']
  if (`$resp -and `$resp.Value) { `$code = [int]`$resp.Value.StatusCode }
  if (`$code -eq 401) {
    throw "The daemon is running and answering on port $DaemonPort, but it rejected this check's token, so the restart itself succeeded. What is wrong is the token: this script read authToken from `$configFile, and that is not the value the daemon booted with -- config.json was edited since it started, or the daemon is using a different state directory (NECESSE_MANAGER_DATA)."
  }
  throw
}
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
