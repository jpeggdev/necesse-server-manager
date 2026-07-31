$ErrorActionPreference = "Stop"
# End-to-end proof of the two claims this installer lives or dies by: the
# bundled Node runtime is what actually runs the daemon, and uninstalling never
# touches the state directory. Everything happens inside one scratch directory
# under TEMP with /DIR= pointed at it.
#
# It passes /TASKS="" throughout, which is now genuinely what keeps a scheduled
# task and a firewall rule off this machine. That was not true of an earlier
# revision, and the earlier note here blamed Inno for it, wrongly: /TASKS
# behaves exactly as documented on 6.7.3. Our own CurPageChanged(wpSelectTasks)
# fired under /VERYSILENT and its WizardSelectTasks calls ran last, overwriting
# whatever the command line had set. Fixed in necesse-daemon.iss with an early
# "if WizardSilent then Exit".
#
# Installing against an empty state directory is kept as a second line of
# defence rather than the only one, so that even a regression in that fix
# cannot reach register-task.ps1 from here. Both are asserted below, not
# assumed, and the assertion that no post-install notice fires is paired with a
# control install that makes one fire on purpose.
#
# Run it as: pwsh -NoProfile -File installer\verify-installer.ps1

$repo       = Split-Path -Parent $PSScriptRoot
$work       = Join-Path $env:TEMP ("instver-" + [guid]::NewGuid().ToString("N"))
$stage      = Join-Path $work "stage"
$out        = Join-Path $work "out"
$dest       = Join-Path $work "app"
# The populated state directory the survival claim is about. Seeded before the
# install, not just before the uninstall, so both halves are covered.
$state      = Join-Path $work "state"
# Deliberately left empty and used only for the launcher test, so the daemon
# refuses to boot and exits instead of binding a port. It also keeps the
# refusal's boot-refusal.txt out of $state, whose contents must not change.
$runState   = Join-Path $work "runstate"
$dest2      = Join-Path $work "app2"
$state2     = Join-Path $work "state2"
$issHarness = Join-Path $repo "installer\necesse-daemon.harness.iss"
$realState  = Join-Path $env:ProgramData "NecesseServerManager"
# Inno derives the Add/Remove Programs key from AppId in necesse-daemon.iss.
$arpKey     = "{7B1B3E2A-9C4D-4F2E-A6D1-2E5C9F0B4A17}_is1"
$version    = "0.0.0-test"
$startedAt  = Get-Date

$passes = 0
$fails  = 0
function Check($n, $ok, $d) {
  if ($ok) { $script:passes++; Write-Host "PASS  ${n}  ${d}" }
  else     { $script:fails++;  Write-Host "FAIL  ${n}  ${d}" }
}
function Info($m) { Write-Host "      $m" }

# ---------------------------------------------------------------- environment

# Resolve-Iscc now lives in resolve-iscc.ps1, shared with the CI and release
# workflows' installer-build steps, so there is one definition instead of
# three that can drift.
. (Join-Path $PSScriptRoot "resolve-iscc.ps1")
$iscc = Resolve-Iscc

$isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "Using ISCC:       $iscc"
Write-Host "Running elevated: $isElevated"
Write-Host "Scratch root:     $work"
Write-Host ""

function Show-RealState($label) {
  $exists = Test-Path $realState
  Write-Host "Real state dir ($label): $realState exists=$exists"
  if ($exists) { Get-ChildItem -Recurse -Force $realState | ForEach-Object { Write-Host "    $($_.FullName)" } }
}

# --------------------------------------------------------------- process help

# Inno never does the work in the process you launched: setup.exe unpacks
# itself to a temporary setup.tmp, and unins000.exe re-execs as _iuXXXX.tmp,
# both of which exit the launcher immediately. Waiting only on the handle
# Start-Process returns therefore proves nothing about whether the install or
# uninstall has finished -- and on the uninstall side that would let the state
# directory be checked before the uninstaller had a chance to touch it, making
# the whole point of this script vacuous. Wait for the family to go quiet.
function Get-SetupProcesses {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      # The worker keeps the ".tmp" suffix in its process name
      # (necesse-daemon-v0.0.0-test-setup.tmp, _unins.tmp), so a pattern
      # anchored on the .exe name matches nothing and every wait below returns
      # instantly -- which is how a run reported a hung uninstaller as
      # COMPLETED and left two message boxes sitting on the desktop.
      # Still matched narrowly, because Stop-SetupProcesses kills whatever this
      # returns and a bare "setup" would eventually hit some unrelated
      # installer the operator is running.
      $path = $null
      try { $path = $_.Path } catch { }
      ($_.ProcessName -like 'necesse-daemon-v*setup*') -or
      ((($_.ProcessName -like '_unins*') -or ($_.ProcessName -like '_iu*')) -and $path -and $path.StartsWith($env:TEMP, [System.StringComparison]::OrdinalIgnoreCase)) -or
      ($path -and $path.StartsWith($work, [System.StringComparison]::OrdinalIgnoreCase))
    })
}
# Set by Wait-SetupIdle, read by the callers as a positive control. "The
# process family went quiet" is trivially true of a matcher that matches
# nothing, which is exactly the bug the comment above describes -- so every
# caller also asserts that something was actually seen.
$script:sawSetupProcess = $false
function Wait-SetupIdle([int]$TimeoutMs) {
  $script:sawSetupProcess = $false
  # Phase 1: wait for the worker to appear. Looking too early and concluding
  # "idle" is the same failure as never matching at all.
  $appearBy = (Get-Date).AddMilliseconds(20000)
  while ((Get-Date) -lt $appearBy) {
    if ((Get-SetupProcesses).Count -gt 0) { $script:sawSetupProcess = $true; break }
    Start-Sleep -Milliseconds 200
  }
  # Phase 2: wait for it to finish.
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    if ((Get-SetupProcesses).Count -eq 0) { return $true }
    $script:sawSetupProcess = $true
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Stop-SetupProcesses {
  foreach ($p in Get-SetupProcesses) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 1000
}

# ------------------------------------------------------------ the fake daemon
#
# FINDING I6. Every other case in this script takes preflight.ps1's "nothing
# listening" branch, so the session-preflight gate was asserted only negatively
# ("the log does NOT say aborting") -- which deleting the whole
# RunSessionPreflight() call from CurStepChanged would have left green, on the
# single most consequential branch in the .iss. The cases at the bottom of this
# script stand up something that actually answers /api/status so the gate can be
# asserted positively, and then compile a copy with the call removed to prove
# those assertions can go red.
#
# A raw TcpListener rather than HttpListener: HttpListener needs a URL ACL
# reservation (or elevation) for an arbitrary port, and this script's whole
# point is to run unelevated on a workstation. Both loopback families are bound
# because preflight.ps1 asks for "localhost" and Windows resolves that to ::1
# first -- an IPv4-only stand-in would be answered by nothing and the case would
# pass for the wrong reason.
$psExe        = (Get-Process -Id $PID).Path
$fakeScript   = Join-Path $work "fake-daemon.ps1"
$fakeBodyFile = Join-Path $work "fake-daemon-body.json"
$fakeStopFile = Join-Path $work "fake-daemon.stop"
$script:fakeProc = $null

$fakeDaemonSource = @'
param([int]$Port, [string]$BodyFile, [string]$StopFile)
$ErrorActionPreference = "Stop"
$body = [System.Text.Encoding]::ASCII.GetBytes((Get-Content $BodyFile -Raw))
$head = [System.Text.Encoding]::ASCII.GetBytes(
  "HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n")

$listeners = @()
foreach ($addr in @([System.Net.IPAddress]::Loopback, [System.Net.IPAddress]::IPv6Loopback)) {
  try {
    $l = [System.Net.Sockets.TcpListener]::new($addr, $Port)
    $l.Start()
    $listeners += $l
    Write-Host "listening on $addr`:$Port"
  } catch {
    Write-Host "could not listen on $addr`:$Port - $($_.Exception.Message)"
  }
}
if ($listeners.Count -eq 0) { throw "fake daemon could not bind port $Port on either loopback family." }

$deadline = (Get-Date).AddMinutes(10)
while (((Get-Date) -lt $deadline) -and (-not (Test-Path $StopFile))) {
  $served = $false
  foreach ($l in $listeners) {
    if (-not $l.Pending()) { continue }
    $served = $true
    $client = $l.AcceptTcpClient()
    try {
      $s = $client.GetStream()
      $s.ReadTimeout = 2000
      $buf = New-Object byte[] 8192
      try { $null = $s.Read($buf, 0, $buf.Length) } catch { }
      $s.Write($head, 0, $head.Length)
      $s.Write($body, 0, $body.Length)
      $s.Flush()
    } catch {
      Write-Host "serve failed: $($_.Exception.Message)"
    }
    $client.Close()
  }
  if (-not $served) { Start-Sleep -Milliseconds 50 }
}
foreach ($l in $listeners) { $l.Stop() }
Write-Host "fake daemon stopped"
'@

function Get-FreePort {
  $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $probe.Start()
  $port = $probe.LocalEndpoint.Port
  $probe.Stop()
  return $port
}

# Returns whether the thing actually answers, probed exactly the way
# preflight.ps1 will probe it. That return value is asserted as a control on
# every case below: a stand-in nobody could reach would make "the install was
# aborted" fail for a reason that has nothing to do with the gate.
function Start-FakeDaemon([int]$Port) {
  Set-Content -Path $fakeScript -Value $fakeDaemonSource -Encoding UTF8
  Remove-Item -Force $fakeStopFile -ErrorAction SilentlyContinue
  $script:fakeProc = Start-Process -FilePath $psExe -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $work "fake-daemon.out") `
    -RedirectStandardError  (Join-Path $work "fake-daemon.err") `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $fakeScript,
                    '-Port', "$Port", '-BodyFile', $fakeBodyFile, '-StopFile', $fakeStopFile)
  $ready = $false
  $by = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $by) {
    try {
      $probe = Invoke-RestMethod "http://localhost:$Port/api/status" -TimeoutSec 5
      if ($probe) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  return $ready
}

function Stop-FakeDaemon {
  if (Test-Path $work) { Set-Content -Path $fakeStopFile -Value "stop" -ErrorAction SilentlyContinue }
  if ($script:fakeProc) {
    if (-not $script:fakeProc.WaitForExit(10000)) {
      Stop-Process -Id $script:fakeProc.Id -Force -ErrorAction SilentlyContinue
    }
    $script:fakeProc = $null
  }
}

# Every root Inno might have written to: an admin install registers under
# HKLM, a lowest-privilege one under HKCU, so a cleanup that checks only one
# leaves a dangling Add/Remove Programs entry behind on this machine.
$arpRoots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)
function Get-ArpEntries { @($arpRoots | ForEach-Object { Join-Path $_ $arpKey } | Where-Object { Test-Path $_ }) }
$startMenuGroups = @(
  (Join-Path $env:APPDATA     'Microsoft\Windows\Start Menu\Programs\Necesse Server Manager'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Necesse Server Manager')
)

# Runs whatever happens, including on a throw or a killed measurement run. The
# previous attempt at this task left an Add/Remove Programs entry, a Start Menu
# group and a scratch install directory on the machine precisely because
# cleanup sat at the end of the happy path.
function Invoke-Cleanup {
  Stop-FakeDaemon
  Stop-SetupProcesses
  foreach ($k in Get-ArpEntries) { Remove-Item -Recurse -Force $k -ErrorAction SilentlyContinue }
  foreach ($g in $startMenuGroups) { Remove-Item -Recurse -Force $g -ErrorAction SilentlyContinue }
  Remove-Item -Force $issHarness -ErrorAction SilentlyContinue
  # A killed measurement run strands the is-XXXX.tmp directory Inno unpacked
  # itself into. Scoped to ones created after this script started, so it can
  # never delete the working directory of an installer someone else is running.
  foreach ($d in @(Get-ChildItem $env:TEMP -Filter 'is-*.tmp' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.CreationTime -ge $startedAt })) {
    Remove-Item -Recurse -Force $d.FullName -ErrorAction SilentlyContinue
  }
  # Windows keeps the compiled setup.exe's image mapped for a few seconds after
  # the process that ran it is gone, so one delete attempt loses the race and
  # strands the scratch directory -- which is how the previous attempt littered
  # TEMP. Retry, and say so out loud if it still will not go.
  for ($i = 0; $i -lt 10 -and (Test-Path $work); $i++) {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    if (Test-Path $work) { Start-Sleep -Seconds 2 }
  }
  if (Test-Path $work) { Write-Host "WARNING: could not delete scratch directory $work - remove it by hand" }
  Remove-Item Env:\NECESSE_MANAGER_DATA -ErrorAction SilentlyContinue
}

# ------------------------------------------------------------------- manifest

# The survival assertion compares content, not just presence: a check that only
# asked "does config.json still exist" would pass against a truncated or
# rewritten file.
function Get-StateManifest($root) {
  if (-not (Test-Path $root)) { return @() }
  @(Get-ChildItem -Recurse -File -Force $root | Sort-Object FullName | ForEach-Object {
      $rel = $_.FullName.Substring($root.Length).TrimStart('\')
      "$rel  $((Get-FileHash $_.FullName -Algorithm SHA256).Hash)"
    })
}

# --------------------------------------------------------------------- compile

# PrivilegesRequired=admin means every install and uninstall pops a UAC consent
# prompt. Nothing in this session can answer that prompt, and leaving one stuck
# on the operator's desktop is worse than not testing elevation, so a
# non-elevated run compiles a throwaway copy with that one line relaxed. An
# elevated run (CI provides one) compiles the committed file untouched.
#
# That is now the ONLY difference. This used to also rewrite the [Dirs] entry,
# because {commonappdata}\NecesseServerManager is a static Inno constant that
# cannot see NECESSE_MANAGER_DATA, so any compiled run created the real state
# directory regardless of the override. That is fixed in the .iss itself
# ({code:StateDirConst}), which means the harness no longer has to hide it --
# and the installer honouring the override is now something this script can
# assert instead of something it papers over.
function Build-Setup([string]$OutDir, [string]$Version, [string]$StageDir = $stage, [switch]$RemovePreflightCall) {
  $text = Get-Content (Join-Path $repo "installer\necesse-daemon.iss") -Raw
  if (-not $isElevated) {
    $from = "PrivilegesRequired=admin"
    if (-not $text.Contains($from)) { throw "harness patch target not found in necesse-daemon.iss: $from" }
    $text = $text.Replace($from, "PrivilegesRequired=lowest")
  }
  # FINDING I6: the substitution build. Deletes the call to
  # RunSessionPreflight() from CurStepChanged and nothing else, so the cases
  # below can show that removing the gate really does turn their assertions
  # red. Throwaway, exactly like the PrivilegesRequired patch above -- the
  # committed .iss is never modified.
  if ($RemovePreflightCall) {
    $callSite = "if RunSessionPreflight() then"
    if (-not $text.Contains($callSite)) { throw "substitution patch target not found in necesse-daemon.iss: $callSite" }
    $text = $text.Replace($callSite, "if True then // RunSessionPreflight() removed for the substitution proof")
  }
  [System.IO.File]::WriteAllText($issHarness, $text, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $log = Join-Path $work "iscc.log"
    & $iscc "/DStageDir=$StageDir" "/DAppVersion=$Version" "/DOutDir=$OutDir" $issHarness *>&1 | Out-File -FilePath $log -Encoding utf8
    if ($LASTEXITCODE -ne 0) { Get-Content $log | Out-Host; throw "ISCC compile failed (exit $LASTEXITCODE)" }
    Info "ISCC: $(Get-Content $log | Select-Object -Last 1)"
  } finally { Remove-Item -Force $issHarness -ErrorAction SilentlyContinue }
  return (Join-Path $OutDir "necesse-daemon-v$Version-setup.exe")
}

# =============================================================================
try {
  Show-RealState "before"
  $realExistedBefore = Test-Path $realState
  $realBefore = Get-StateManifest $realState
  Write-Host ""

  Check "no stale Add/Remove Programs entry for this AppId" ((Get-ArpEntries).Count -eq 0) "$((Get-ArpEntries) -join ', ')"
  # A setup or uninstall process left over from an earlier run would make every
  # Wait-SetupIdle below time out against someone else's window.
  Check "no leftover setup/uninstall process from an earlier run" ((Get-SetupProcesses).Count -eq 0) "$((Get-SetupProcesses | ForEach-Object { $_.ProcessName }) -join ', ')"
  # The installer's preflight probes this port; something else holding it would
  # make the gate's verdict mean something other than what this script assumes.
  $portFree = @(Get-NetTCPConnection -LocalPort 8710 -State Listen -ErrorAction SilentlyContinue).Count -eq 0
  Check "port 8710 is free before starting" $portFree ""

  # $state is deliberately NOT created here. The installer's [Dirs] entry is
  # what should create it, at whatever NECESSE_MANAGER_DATA resolves to -- so
  # its existence afterwards is the proof that the entry follows the override
  # instead of hardcoding %PROGRAMDATA%.
  New-Item -ItemType Directory -Force $work, $out, $runState, $state2 | Out-Null

  # Set for the whole process, not just one invocation: Start-Process inherits
  # the parent environment, so this is what keeps the installer, the
  # uninstaller and their preflight scripts all reading the scratch directory
  # instead of the real %PROGRAMDATA%\NecesseServerManager.
  $env:NECESSE_MANAGER_DATA = $state

  # The state directory is deliberately left EMPTY for the install and only
  # seeded afterwards, for the uninstall.
  #
  # With CurPageChanged fixed, /TASKS="" now deselects the boot task outright,
  # so this is no longer the only thing keeping a real Scheduled Task off the
  # machine -- it is defence in depth. It still earns its place: if that fix
  # ever regresses, ConfigExists() returning False sends the boot-task branch
  # to its "nothing to register" notice instead of executing
  # {app}\register-task.ps1, so a regression costs a failed check here rather
  # than a boot task and an open firewall port on the machine under test.
  # An earlier revision of this script seeded config.json before the install
  # and did execute register-task.ps1; it created nothing only because this
  # session is not elevated.
  Info "state directory left empty for the install: $state"

  # ------------------------------------------------------------------- build
  Write-Host ""
  Write-Host "--- building payload ---"
  $buildLog = Join-Path $work "build.log"
  Push-Location (Join-Path $repo "daemon")
  try {
    npm run build *>&1 | Out-File -FilePath $buildLog -Encoding utf8
    if ($LASTEXITCODE -ne 0) { Get-Content $buildLog | Out-Host; throw "daemon build failed" }
  } finally { Pop-Location }
  Info "npm run build: $(Get-Content $buildLog | Select-Object -Last 1)"

  # stage-daemon.ps1 runs npm ci, which is thousands of lines of noise that
  # would bury every result below it. Captured in full, summarised here.
  $stageLog = Join-Path $work "stage.log"
  & pwsh -NoProfile -File (Join-Path $repo "installer\stage-daemon.ps1") -RepoRoot $repo -StageDir $stage *>&1 | Out-File -FilePath $stageLog -Encoding utf8
  if ($LASTEXITCODE -ne 0) { Get-Content $stageLog | Out-Host; throw "stage-daemon.ps1 failed (exit $LASTEXITCODE)" }
  Info "stage-daemon.ps1: $(Get-Content $stageLog | Select-Object -Last 1)"

  & pwsh -NoProfile -File (Join-Path $repo "installer\fetch-node.ps1") -StageDir $stage -RepoRoot $repo | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "fetch-node.ps1 failed (exit $LASTEXITCODE)" }
  Check "stage has a bundled node" (Test-Path (Join-Path $stage "node\node.exe")) ""

  $wantNode = "v" + (Get-Content (Join-Path $repo "installer\node-version.txt") -Raw).Trim()
  $gotNode = (& (Join-Path $stage "node\node.exe") -v).Trim()
  Check "bundled node is the pinned version" ($gotNode -eq $wantNode) "want=$wantNode got=$gotNode"

  Write-Host ""
  Write-Host "--- compiling installer ---"
  $setup = Build-Setup -OutDir $out -Version $version
  Check "installer compiled" (Test-Path $setup) ""

  # ----------------------------------------------------------------- install
  Write-Host ""
  Write-Host "--- silent install ---"
  # /TASKS="" deselects both post-install actions. That is now true -- it was
  # not before necesse-daemon.iss stopped running CurPageChanged under silence,
  # and the comment that used to sit here asserting it was the belief that made
  # an earlier revision of this script execute register-task.ps1. It is proved
  # below by the absence of any post-install notice, paired with a control
  # install that deliberately selects both tasks and makes those notices fire.
  #
  # Not -Wait: Wait-SetupIdle needs the worker to still be alive to observe it,
  # and its positive control is the whole point of the check that follows.
  $installLog = Join-Path $work "install.log"
  $p = Start-Process -FilePath $setup -PassThru -ArgumentList @(
    "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/DIR=$dest", "/TASKS=""""", "/LOG=$installLog")
  $installIdle = Wait-SetupIdle 180000
  Check "install finished (no setup process left running)" $installIdle ""
  Check "control: the install wait actually observed a setup process" $script:sawSetupProcess ""
  $p.WaitForExit(15000) | Out-Null
  $p.Refresh()
  Check "silent install exit 0" ($p.ExitCode -eq 0) "exit=$($p.ExitCode)"

  # The session preflight runs before anything is stopped or copied and aborts
  # an unattended install outright when a game session may be live. Reaching
  # the installed files at all means it returned 0, but say so explicitly -- an
  # abort here would be the gate working, not a harness bug.
  #
  # This is the NEGATIVE half only, and on its own it was vacuous: this case
  # takes the "nothing listening" branch, so it stayed green with the whole
  # RunSessionPreflight() call deleted. The positive half, with something that
  # actually answers /api/status, is at the bottom of this script, along with a
  # substitution build that proves it can go red.
  $installLogText = if (Test-Path $installLog) { Get-Content $installLog -Raw } else { "" }
  Check "session preflight passed (install was not aborted)" ($installLogText -notmatch 'aborting unattended install') ""

  # /TASKS="" really deselected both tasks: neither post-install branch was
  # entered, so nothing was shown and nothing was logged as suppressed. The
  # control install near the end of this script makes both of those notices
  # fire on purpose, so this check failing open is not possible without that
  # control failing too.
  Check "/TASKS=`"`" deselected both tasks (no post-install notice or message box)" (
    ($installLogText -notmatch 'Message box') -and ($installLogText -notmatch 'Notice \(silent, not shown\)')) ""
  Check "setup wizard was not launched" ($installLogText -notmatch 'setup wizard did not complete') ""
  Check "no NecesseDaemon scheduled task was created" (
    $null -eq (Get-ScheduledTask -TaskName 'NecesseDaemon' -ErrorAction SilentlyContinue)) ""
  Check "no NecesseDaemon-Inbound firewall rule was created" (
    $null -eq (Get-NetFirewallRule -Name 'NecesseDaemon-Inbound' -ErrorAction SilentlyContinue)) ""

  foreach ($f in @("dist\index.js","dist\setup-cli.js","dist\migrate-cli.js","node\node.exe","start-daemon.cmd","setup.cmd","migrate.cmd","register-task.cmd","register-task.ps1","config.example.json","package.json")) {
    Check "installed: $f" (Test-Path (Join-Path $dest $f)) ""
  }
  Check "node_modules installed" (Test-Path (Join-Path $dest "node_modules\fastify")) ""
  # dontcopy in [Files]: an install-time tool, extracted to {tmp} and never
  # part of the daemon, so finding it in {app} means the flag was lost.
  Check "preflight.ps1 not installed into {app}" (-not (Test-Path (Join-Path $dest "preflight.ps1"))) ""
  Check "Add/Remove Programs entry registered" ((Get-ArpEntries).Count -eq 1) "$((Get-ArpEntries) -join ', ')"
  # FINDING D: [Dirs] and the "Open state folder" shortcut both resolve through
  # {code:StateDirConst}, so they follow NECESSE_MANAGER_DATA. The state folder
  # appearing where the override points -- and nowhere else -- is that fix.
  Check "[Dirs] created the state folder at NECESSE_MANAGER_DATA, not %PROGRAMDATA%" (Test-Path $state) ""
  # If that ever regresses, everything downstream (seeding, manifests) would
  # throw under $ErrorActionPreference = "Stop" and abort the run before the
  # assertions that matter. A harness should fail its check and carry on, not
  # die on the way to it.
  if (-not (Test-Path $state)) { New-Item -ItemType Directory -Force $state | Out-Null }

  # Both Start Menu roots: {group} is the per-user profile under a
  # lowest-privilege install and the common profile under an elevated one, so
  # looking only in %APPDATA% makes this evaporate silently on CI -- the one
  # place the elevated path is ever exercised. Existence is a Check, not a
  # precondition, for the same reason.
  $lnk = @($startMenuGroups | ForEach-Object { Join-Path $_ 'Open state folder.lnk' } | Where-Object { Test-Path $_ })
  Check "'Open state folder' shortcut was created" ($lnk.Count -eq 1) "found $($lnk.Count) in $($startMenuGroups.Count) roots"
  $lnkTarget = if ($lnk.Count -eq 1) { (New-Object -ComObject WScript.Shell).CreateShortcut($lnk[0]).TargetPath } else { "<no shortcut>" }
  Check "'Open state folder' shortcut points at the real state directory" ($lnkTarget -eq $state) "target=$lnkTarget"

  Check "install wrote nothing into the state directory" ((Get-StateManifest $state).Count -eq 0) ""

  # ------------------------------------------- the bundled runtime is genuine
  Write-Host ""
  Write-Host "--- bundled runtime ---"
  # Everything below runs with node stripped from PATH. An install that quietly
  # fell through to the system Node would otherwise pass identically, which is
  # the entire reason for bundling one.
  $safePath = "C:\Windows\System32;C:\Windows"
  function Invoke-Stripped([string]$Inner, [string]$OutFile) {
    & cmd /c "set `"PATH=$safePath`" && set `"NECESSE_MANAGER_DATA=$runState`" && $Inner" > $OutFile 2>&1
    return $LASTEXITCODE
  }

  # Negative control. If node were still reachable here, every result below
  # would be worthless -- the daemon could be running on the system Node and
  # nothing in this script would notice.
  $whereOut = Join-Path $work "where-node.out"
  $whereCode = Invoke-Stripped "where node" $whereOut
  Check "control: no node reachable on the stripped PATH" ($whereCode -ne 0) "where node exit=$whereCode"

  $runOut = Join-Path $work "run.out"
  Invoke-Stripped "`"$dest\start-daemon.cmd`"" $runOut | Out-Null
  $runText = Get-Content $runOut -Raw
  Check "launcher produced output at all" (-not [string]::IsNullOrWhiteSpace($runText)) "$(($runText -split "`r?`n").Count) lines"
  Check "runs on the bundled node with no node on PATH" (($runText -notmatch "is not recognized") -and ($runText -notmatch "MODULE_NOT_FOUND")) ""
  Check "and refuses cleanly, naming setup.cmd" ($runText -match "setup\.cmd") ""
  Info "launcher said: $(((($runText -split "`r?`n") | Where-Object { $_.Trim() }) | Select-Object -First 2) -join ' | ')"

  # Substitution proof for the check above: with the bundled node moved aside
  # and none on PATH, the same command MUST fail. A check that stays green here
  # was never testing the bundled runtime at all.
  $bundled = Join-Path $dest "node\node.exe"
  $hidden  = Join-Path $dest "node\node.exe.hidden"
  Move-Item $bundled $hidden
  try {
    $noNodeOut = Join-Path $work "run-nonode.out"
    Invoke-Stripped "`"$dest\start-daemon.cmd`"" $noNodeOut | Out-Null
    $noNodeText = Get-Content $noNodeOut -Raw
    Check "substitution proof: bundled node moved aside, launcher now fails" ($noNodeText -match "is not recognized") "$(($noNodeText -split "`r?`n")[0])"
  } finally { Move-Item $hidden $bundled }
  Check "bundled node restored after the substitution proof" (Test-Path $bundled) ""

  # A missing config.json is a plain thrown Error out of loadConfig, not one of
  # the resolveBootConfig refusals that write boot-refusal.txt -- so the thing
  # to assert is that it refused instead of starting: nothing is left listening.
  Check "launcher refused rather than started (nothing listening on 8710)" (
    @(Get-NetTCPConnection -LocalPort 8710 -State Listen -ErrorAction SilentlyContinue).Count -eq 0) ""
  Check "launcher test wrote nothing into the state directory" ((Get-StateManifest $state).Count -eq 0) ""

  # --------------------------------------------------------------- uninstall
  Write-Host ""
  Write-Host "--- silent uninstall ---"
  # Seeded now, between install and uninstall: this is the content whose
  # survival is the point of the script. It also gives the uninstaller's own
  # preflight a config.json to read, so that side exercises the "port probed,
  # connection refused" branch rather than the "no config" one.
  Set-Content -Path (Join-Path $state "config.json") -Value '{"port":8710,"authToken":""}' -NoNewline
  New-Item -ItemType Directory -Force (Join-Path $state "mod-library\abc") | Out-Null
  Set-Content -Path (Join-Path $state "mod-library\abc\a.jar") -Value "JAR-CONTENT-THAT-MUST-SURVIVE" -NoNewline
  $stateBefore = Get-StateManifest $state
  Info "seeded state directory: $($stateBefore.Count) files under $state"
  $unins = Join-Path $dest "unins000.exe"
  Check "uninstaller present" (Test-Path $unins) ""
  $u = Start-Process -FilePath $unins -PassThru -ArgumentList @("/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART")
  # unins000.exe re-execs as %TEMP%\is-*-uninstall.tmp\_unins.tmp and returns
  # immediately, so its exit code is the launcher's, not the uninstall's.
  # Waiting for the family to go quiet is what makes the assertions below mean
  # anything -- and the positive control is what makes the wait mean anything.
  $uninstallIdle = Wait-SetupIdle 180000
  Check "uninstall finished (no uninstaller process left running)" $uninstallIdle "launcher exit=$($u.ExitCode)"
  Check "control: the uninstall wait actually observed an uninstaller process" $script:sawSetupProcess ""
  Check "install directory removed" (-not (Test-Path (Join-Path $dest "dist\index.js"))) ""
  Check "Add/Remove Programs entry removed" ((Get-ArpEntries).Count -eq 0) "$((Get-ArpEntries) -join ', ')"
  Check "Start Menu group removed" ((@($startMenuGroups | Where-Object { Test-Path $_ })).Count -eq 0) ""

  # The assertion this whole script exists for.
  Write-Host ""
  $stateAfter = Get-StateManifest $state
  Check "STATE DIRECTORY SURVIVED" (Test-Path (Join-Path $state "config.json")) ""
  Check "MOD LIBRARY SURVIVED" ((Get-Content (Join-Path $state "mod-library\abc\a.jar") -Raw -ErrorAction SilentlyContinue) -eq "JAR-CONTENT-THAT-MUST-SURVIVE") ""
  Check "STATE DIRECTORY BYTE-IDENTICAL ACROSS THE UNINSTALL" (($stateAfter -join "`n") -eq ($stateBefore -join "`n")) "$($stateBefore.Count) files before, $($stateAfter.Count) after"

  # ------------------------------ measurement, and the control for /TASKS=""
  # This used to be a pure measurement, because a plain /VERYSILENT run hung
  # forever on a SuppressibleMsgBox and hanging was merely reported. It is a
  # Check now: needing a second flag (/SUPPRESSMSGBOXES) to avoid an unbounded
  # hang is not an acceptable contract, so the .iss suppresses those boxes
  # under silence itself and completing is a requirement.
  #
  # It deliberately selects BOTH tasks, which is the opposite of the main run.
  # That does three jobs at once: it reaches the informational notice the boot
  # task branch emits (proving the main run's "no notice" check is reading a
  # live signal, not a dead one); it reaches the setup-wizard branch (which
  # must decline to launch an interactive wizard with no console); and it does
  # both with no /SUPPRESSMSGBOXES, which is where the hang used to be. The
  # state directory stays empty so the boot task branch still cannot reach
  # register-task.ps1.
  Write-Host ""
  Write-Host "--- control + measurement: BOTH tasks selected, no /SUPPRESSMSGBOXES ---"
  $env:NECESSE_MANAGER_DATA = $state2
  $m1Log = Join-Path $work "measure-install.log"
  $m1 = Start-Process -FilePath $setup -PassThru -ArgumentList @(
    "/VERYSILENT", "/NORESTART", "/DIR=$dest2", "/TASKS=runsetup,boottask", "/LOG=$m1Log")
  $m1Done = Wait-SetupIdle 120000
  if ($m1Done) { $m1.WaitForExit(15000) | Out-Null; $m1.Refresh() }
  if ($m1Done) {
    Write-Host "MEASUREMENT install   /VERYSILENT alone: COMPLETED, exit=$($m1.ExitCode)"
  } else {
    Write-Host "MEASUREMENT install   /VERYSILENT alone: DID NOT COMPLETE within 120s - killed"
    if (Test-Path $m1Log) {
      Write-Host "  last lines of its Inno log, i.e. where it stopped:"
      Get-Content $m1Log -Tail 8 | ForEach-Object { Write-Host "    $_" }
    }
    Stop-SetupProcesses
  }
  Check "install without /SUPPRESSMSGBOXES completes instead of hanging" $m1Done ""

  $m1Text = if (Test-Path $m1Log) { Get-Content $m1Log -Raw } else { "" }
  Check "control: with boottask selected, its notice IS emitted" (
    $m1Text -match 'Notice \(silent, not shown\).*boot task was not registered') ""
  Check "no real message box was shown even without /SUPPRESSMSGBOXES" ($m1Text -notmatch 'Message box') ""
  Check "silent install declined to launch the interactive setup wizard" (
    $m1Text -match 'not launching the interactive setup wizard') ""
  Check "boottask selected but register-task.ps1 still not reached (no scheduled task)" (
    $null -eq (Get-ScheduledTask -TaskName 'NecesseDaemon' -ErrorAction SilentlyContinue)) ""

  # The box that fired on every single uninstall (usPostUninstall, "the daemon
  # has been removed") was the last unconditional blocker on either path, so
  # the uninstall side gets the same treatment and the same check.
  $unins2 = Join-Path $dest2 "unins000.exe"
  if (Test-Path $unins2) {
    $m2 = Start-Process -FilePath $unins2 -PassThru -ArgumentList @("/VERYSILENT","/NORESTART")
    $m2Done = Wait-SetupIdle 120000
    if ($m2Done) { Write-Host "MEASUREMENT uninstall /VERYSILENT alone: COMPLETED" }
    else {
      Write-Host "MEASUREMENT uninstall /VERYSILENT alone: DID NOT COMPLETE within 120s - killed"
      Stop-SetupProcesses
    }
    Check "uninstall without /SUPPRESSMSGBOXES completes instead of hanging" $m2Done ""
    Check "that uninstall removed its install directory" (-not (Test-Path (Join-Path $dest2 "dist\index.js"))) ""
  } else {
    Check "uninstall without /SUPPRESSMSGBOXES completes instead of hanging" $false "no uninstaller; the install above did not get that far"
  }

  # ------------------------------------------- regression case for FINDING G
  # The one topology every other case here is structurally blind to: no /TASKS
  # switch at all, on a machine that is ALREADY configured. Everything else in
  # this script passes /TASKS explicitly and keeps the state directory empty,
  # so "section defaults decide" and "config.json exists" never meet -- and
  # that intersection is precisely where the regression lived. Making
  # CurPageChanged skip silent runs handed the decision to the [Tasks]
  # defaults, and a default of checked would have registered a boot task on an
  # unattended upgrade of a machine whose operator had deliberately never
  # created one.
  #
  # If boottask were selected here, CurStepChanged would find config.json and
  # execute register-task.ps1 for real, leaving a Scheduled Task and an open
  # port 8710 on the machine running the tests -- on CI, elevated, it would
  # succeed. So this case installs a payload whose register-task.ps1 is a
  # sentinel that only writes a marker file: a regression is then reported
  # rather than inflicted. Nothing else about the payload matters, because what
  # is under test is the task-selection decision and nothing downstream of it.
  Write-Host ""
  Write-Host "--- regression case: no /TASKS switch, state directory already configured ---"
  $stageG   = Join-Path $work "stage-g"
  $outG     = Join-Path $work "out-g"
  $destG    = Join-Path $work "app-g"
  $stateG   = Join-Path $work "state-g"
  $sentinel = Join-Path $work "register-task-was-invoked.txt"
  New-Item -ItemType Directory -Force $stageG, $outG, $stateG | Out-Null
  Set-Content -Path (Join-Path $stateG "config.json") -Value '{"port":8710,"authToken":""}' -NoNewline
  Set-Content -Path (Join-Path $stageG "register-task.ps1") -Value "Set-Content -Path '$sentinel' -Value 'invoked' -NoNewline`r`nexit 0"
  Set-Content -Path (Join-Path $stageG "setup.cmd") -Value "@echo off`r`nexit /b 0"
  Set-Content -Path (Join-Path $stageG "start-daemon.cmd") -Value "@echo off`r`nexit /b 0"

  $setupG = Build-Setup -OutDir $outG -Version $version -StageDir $stageG
  $env:NECESSE_MANAGER_DATA = $stateG
  $gLog = Join-Path $work "regression-g.log"
  # No /TASKS at all: this is a bare "setup.exe /VERYSILENT" upgrade.
  $g = Start-Process -FilePath $setupG -PassThru -ArgumentList @(
    "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/DIR=$destG", "/LOG=$gLog")
  $gDone = Wait-SetupIdle 120000
  if ($gDone) { $g.WaitForExit(15000) | Out-Null } else { Stop-SetupProcesses }
  Check "bare /VERYSILENT install (no /TASKS) finished" $gDone ""

  $gText = if (Test-Path $gLog) { Get-Content $gLog -Raw } else { "" }
  Info "decision: $((@(Get-Content $gLog -ErrorAction SilentlyContinue | Where-Object { $_ -match 'ssPostInstall: runsetup=' }) | Select-Object -First 1))"
  # Anti-vacuity control. "boottask=no" is also true of every empty-state case
  # already covered above; this is what proves the dangerous topology was the
  # one actually presented.
  Check "control: the regression case really was an already-configured machine" ($gText -match 'configExists=yes') ""
  Check "FINDING G: bare /VERYSILENT leaves boottask DESELECTED on a configured machine" ($gText -match 'boottask=no') ""
  Check "FINDING G: register-task.ps1 was never invoked" (-not (Test-Path $sentinel)) ""
  Check "FINDING G: no scheduled task was created" (
    $null -eq (Get-ScheduledTask -TaskName 'NecesseDaemon' -ErrorAction SilentlyContinue)) ""
  Check "FINDING G: no firewall rule was created" (
    $null -eq (Get-NetFirewallRule -Name 'NecesseDaemon-Inbound' -ErrorAction SilentlyContinue)) ""

  $uninsG = Join-Path $destG "unins000.exe"
  if (Test-Path $uninsG) {
    Start-Process -FilePath $uninsG -PassThru -ArgumentList @("/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART") | Out-Null
    Wait-SetupIdle 120000 | Out-Null
  }
  Check "regression case uninstalled cleanly" ((Get-ArpEntries).Count -eq 0) "$((Get-ArpEntries) -join ', ')"
  Check "regression case left its state directory intact" (Test-Path (Join-Path $stateG "config.json")) ""

  # ------------------------------------------ FINDING I6: the preflight gate
  # The gate that decides whether an install is allowed to stop a daemon that
  # may be mid-session was, until now, asserted only by the ABSENCE of
  # "aborting unattended install" from a log produced on the "nothing
  # listening" branch. Deleting RunSessionPreflight() outright left all 64
  # checks green. These three cases assert it positively and then prove they
  # can fail.
  #
  # A tiny payload of its own: what is under test is a decision taken at
  # ssInstall, before a single file is copied, so nothing downstream of it
  # matters -- and "dist was never created" is the assertion that says the
  # abort happened before the copy, which needs a dist in the payload to be
  # meaningful. register-task.ps1/.cmd are inert stubs so that even a total
  # regression cannot register anything on this machine.
  Write-Host ""
  Write-Host "--- session preflight: a live daemon must abort an unattended install ---"
  $stageP = Join-Path $work "stage-p"
  $outP   = Join-Path $work "out-p"
  New-Item -ItemType Directory -Force $stageP, $outP, (Join-Path $stageP "dist") | Out-Null
  Set-Content -Path (Join-Path $stageP "dist\index.js") -Value "console.log('stub');" -NoNewline
  Set-Content -Path (Join-Path $stageP "setup.cmd") -Value "@echo off`r`nexit /b 0"
  Set-Content -Path (Join-Path $stageP "start-daemon.cmd") -Value "@echo off`r`nexit /b 0"
  Set-Content -Path (Join-Path $stageP "register-task.cmd") -Value "@echo off`r`nexit /b 0"
  Set-Content -Path (Join-Path $stageP "register-task.ps1") -Value "exit 0"

  $setupP    = Build-Setup -OutDir $outP -Version $version -StageDir $stageP
  $setupPsub = Build-Setup -OutDir $outP -Version "$version-nopreflight" -StageDir $stageP -RemovePreflightCall
  Check "substitution build compiled (RunSessionPreflight call removed)" (Test-Path $setupPsub) ""

  # Emits nothing itself; results come back on these $script: variables, because
  # a stray Write-Output inside a PowerShell function silently joins its return
  # value.
  $script:pfReady = $false
  $script:pfDone  = $false
  $script:pfExit  = -1
  $script:pfLog   = ""
  function Invoke-PreflightCase([string]$SetupExe, [string]$Body, [string]$Dest, [string]$StatePath, [string]$LogPath) {
    New-Item -ItemType Directory -Force $StatePath | Out-Null
    $port = Get-FreePort
    # The port comes from config.json, which is what preflight.ps1 reads, so an
    # ephemeral port keeps this off 8710 and away from anything real.
    Set-Content -Path (Join-Path $StatePath "config.json") -Value "{`"port`":$port,`"authToken`":`"`"}" -NoNewline
    Set-Content -Path $fakeBodyFile -Value $Body -NoNewline
    $env:NECESSE_MANAGER_DATA = $StatePath
    $script:pfReady = Start-FakeDaemon $port
    $proc = Start-Process -FilePath $SetupExe -PassThru -ArgumentList @(
      "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/DIR=$Dest", "/TASKS=""""", "/LOG=$LogPath")
    $script:pfDone = Wait-SetupIdle 120000
    if ($script:pfDone) {
      $proc.WaitForExit(15000) | Out-Null
      $proc.Refresh()
      $script:pfExit = $proc.ExitCode
    } else { Stop-SetupProcesses }
    Stop-FakeDaemon
    if (Test-Path $LogPath) { $script:pfLog = Get-Content $LogPath -Raw } else { $script:pfLog = "" }
  }

  $liveBody = '{"state":"running","world":"PreflightWorld","activeTasks":[],"configWarnings":[]}'
  $taskBody = '{"state":"stopped","world":null,"activeTasks":["mod-install-1"],"configWarnings":[]}'

  $destP1 = Join-Path $work "app-p1"
  Invoke-PreflightCase $setupP $liveBody $destP1 (Join-Path $work "state-p1") (Join-Path $work "preflight-live.log")
  Check "control: the stand-in daemon actually answered /api/status" $script:pfReady ""
  Check "install against a live session finished instead of hanging" $script:pfDone "exit=$($script:pfExit)"
  Check "FINDING I6: a running game session ABORTS the unattended install" (
    $script:pfLog -match 'aborting unattended install') ""
  # Anti-vacuity: proves the abort was caused by what the stand-in reported and
  # not by some unrelated failure that also happens to write that line.
  Check "control: the abort quotes the running world the stand-in reported" (
    $script:pfLog -match 'WORLD=PreflightWorld') ""
  Check "FINDING I6: it aborted BEFORE copying anything - {app}\dist was never created" (
    -not (Test-Path (Join-Path $destP1 "dist"))) ""
  Check "FINDING I6: the aborted install registered nothing in Add/Remove Programs" (
    (Get-ArpEntries).Count -eq 0) "$((Get-ArpEntries) -join ', ')"

  $destP2 = Join-Path $work "app-p2"
  Invoke-PreflightCase $setupP $taskBody $destP2 (Join-Path $work "state-p2") (Join-Path $work "preflight-tasks.log")
  Check "control: the stand-in daemon answered (activeTasks case)" $script:pfReady ""
  Check "install against an in-flight task finished instead of hanging" $script:pfDone "exit=$($script:pfExit)"
  # FINDING I5. state is 'stopped' here: on the old code this returned 0 and the
  # install went ahead and force-killed a node that could be mid-writeFile in
  # mod-library.ts.
  Check "FINDING I5: state=stopped but a non-empty activeTasks ABORTS the install" (
    $script:pfLog -match 'aborting unattended install') ""
  Check "control: the abort names the in-flight task, not just the state" (
    $script:pfLog -match 'TASKS=1') ""
  Check "FINDING I5: it aborted BEFORE copying anything - {app}\dist was never created" (
    -not (Test-Path (Join-Path $destP2 "dist"))) ""

  # The substitution proof. Same stand-in, same live body, same switches -- the
  # only difference is a build whose CurStepChanged no longer calls
  # RunSessionPreflight(). Both assertions above MUST invert here, or they were
  # never testing the gate.
  Write-Host ""
  Write-Host "--- substitution proof: the same case against a build with no preflight call ---"
  $destP3 = Join-Path $work "app-p3"
  Invoke-PreflightCase $setupPsub $liveBody $destP3 (Join-Path $work "state-p3") (Join-Path $work "preflight-sub.log")
  Check "control: the stand-in daemon answered (substitution case)" $script:pfReady ""
  Check "substitution proof: with the call removed, the install is NOT aborted" (
    $script:pfLog -notmatch 'aborting unattended install') ""
  Check "substitution proof: and it installs straight over the live session - dist IS created" (
    Test-Path (Join-Path $destP3 "dist\index.js")) ""

  $uninsP = Join-Path $destP3 "unins000.exe"
  if (Test-Path $uninsP) {
    Start-Process -FilePath $uninsP -PassThru -ArgumentList @("/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART") | Out-Null
    Wait-SetupIdle 120000 | Out-Null
  }
  Check "substitution-proof install uninstalled cleanly" ((Get-ArpEntries).Count -eq 0) "$((Get-ArpEntries) -join ', ')"
  Check "no NecesseDaemon scheduled task exists after the preflight cases" (
    $null -eq (Get-ScheduledTask -TaskName 'NecesseDaemon' -ErrorAction SilentlyContinue)) ""

  # -------------------------------------------------------------- real state
  Write-Host ""
  Remove-Item Env:\NECESSE_MANAGER_DATA -ErrorAction SilentlyContinue
  Show-RealState "after"
  Check "real %PROGRAMDATA%\NecesseServerManager unchanged" (
    ((Test-Path $realState) -eq $realExistedBefore) -and (((Get-StateManifest $realState) -join "`n") -eq ($realBefore -join "`n"))
  ) "existed before=$realExistedBefore, exists after=$(Test-Path $realState)"
}
finally {
  Invoke-Cleanup
}

Write-Host ""
Write-Host "PASSES: $passes"
Write-Host "FAILURES: $fails"
if ($fails -gt 0) { exit 1 }
