$ErrorActionPreference = "Stop"
# End-to-end proof of the two claims this installer lives or dies by: the
# bundled Node runtime is what actually runs the daemon, and uninstalling never
# touches the state directory. Everything happens inside one scratch directory
# under TEMP, with /DIR= pointed at it and /TASKS="" throughout, so no
# scheduled task and no firewall rule is ever created on the machine running
# this.
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
$dirsAnchor = Join-Path $work "programdata-anchor\NecesseServerManager"
$issHarness = Join-Path $repo "installer\necesse-daemon.harness.iss"
$realState  = Join-Path $env:ProgramData "NecesseServerManager"
# Inno derives the Add/Remove Programs key from AppId in necesse-daemon.iss.
$arpKey     = "{7B1B3E2A-9C4D-4F2E-A6D1-2E5C9F0B4A17}_is1"
$version    = "0.0.0-test"

$passes = 0
$fails  = 0
function Check($n, $ok, $d) {
  if ($ok) { $script:passes++; Write-Host "PASS  ${n}  ${d}" }
  else     { $script:fails++;  Write-Host "FAIL  ${n}  ${d}" }
}
function Info($m) { Write-Host "      $m" }

# ---------------------------------------------------------------- environment

# ISCC's location depends on how it got there: winget puts it under the
# per-user LOCALAPPDATA, choco (what CI uses) puts it under Program Files
# (x86). A single hardcoded path breaks on whichever machine used the other
# installer, so probe and name everywhere looked at if none exist.
function Resolve-Iscc {
  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
    if ($base) {
      $candidates.Add((Join-Path $base "Inno Setup 6\ISCC.exe"))
      $candidates.Add((Join-Path $base "Programs\Inno Setup 6\ISCC.exe"))
    }
  }
  $onPath = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($onPath) { $candidates.Add($onPath.Source) }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw "ISCC.exe not found. Looked in:`n  $($candidates -join "`n  ")"
}
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
      # Matched narrowly on purpose: Stop-SetupProcesses kills whatever this
      # returns, and a bare "setup" or "unins000" would eventually match some
      # unrelated installer the operator is running.
      $path = $null
      try { $path = $_.Path } catch { }
      ($_.ProcessName -like 'necesse-daemon-v*-setup') -or
      (($_.ProcessName -like '_iu*') -and $path -and $path.StartsWith($env:TEMP, [System.StringComparison]::OrdinalIgnoreCase)) -or
      ($path -and $path.StartsWith($work, [System.StringComparison]::OrdinalIgnoreCase))
    })
}
function Wait-SetupIdle([int]$TimeoutMs) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  # One settle pass first: the launcher can be gone a beat before its
  # replacement appears, which would read as "already idle".
  Start-Sleep -Milliseconds 1500
  while ((Get-Date) -lt $deadline) {
    if ((Get-SetupProcesses).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Stop-SetupProcesses {
  foreach ($p in Get-SetupProcesses) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 1000
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
  Stop-SetupProcesses
  foreach ($k in Get-ArpEntries) { Remove-Item -Recurse -Force $k -ErrorAction SilentlyContinue }
  foreach ($g in $startMenuGroups) { Remove-Item -Recurse -Force $g -ErrorAction SilentlyContinue }
  Remove-Item -Force $issHarness -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
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
# on the operator's desktop is worse than not testing elevation. Separately,
# [Dirs] creates {commonappdata}\NecesseServerManager unconditionally -- that
# is a static Inno constant, not Pascal code, so it cannot see
# NECESSE_MANAGER_DATA at all, and any compiled run would create the real state
# directory regardless of the override.
#
# Both are patched only into a throwaway copy of the .iss, and only when this
# script is not already elevated. An elevated run (CI provides one) compiles
# the committed file untouched. Neither patch is near the two assertions this
# script exists for: the payload, the Pascal code, the uninstaller and the
# state-directory logic are byte-identical either way.
function Build-Setup([string]$OutDir, [string]$Version) {
  $text = Get-Content (Join-Path $repo "installer\necesse-daemon.iss") -Raw
  if (-not $isElevated) {
    foreach ($pair in @(
      @{ From = "PrivilegesRequired=admin"; To = "PrivilegesRequired=lowest" },
      @{ From = 'Name: "{commonappdata}\NecesseServerManager"'; To = ('Name: "' + $dirsAnchor + '"') }
    )) {
      if (-not $text.Contains($pair.From)) { throw "harness patch target not found in necesse-daemon.iss: $($pair.From)" }
      $text = $text.Replace($pair.From, $pair.To)
    }
  }
  [System.IO.File]::WriteAllText($issHarness, $text, (New-Object System.Text.UTF8Encoding($false)))
  try {
    $log = Join-Path $work "iscc.log"
    & $iscc "/DStageDir=$stage" "/DAppVersion=$Version" "/DOutDir=$OutDir" $issHarness *>&1 | Out-File -FilePath $log -Encoding utf8
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
  # The installer's preflight probes this port; something else holding it would
  # make the gate's verdict mean something other than what this script assumes.
  $portFree = @(Get-NetTCPConnection -LocalPort 8710 -State Listen -ErrorAction SilentlyContinue).Count -eq 0
  Check "port 8710 is free before starting" $portFree ""

  New-Item -ItemType Directory -Force $work, $out, $state, $runState, $state2 | Out-Null

  # Set for the whole process, not just one invocation: Start-Process inherits
  # the parent environment, so this is what keeps the installer, the
  # uninstaller and their preflight scripts all reading the scratch directory
  # instead of the real %PROGRAMDATA%\NecesseServerManager.
  $env:NECESSE_MANAGER_DATA = $state

  # Seeded before the install, so the install, the preflight gate and the
  # uninstall are all exercised against a state directory that has something in
  # it worth losing.
  Set-Content -Path (Join-Path $state "config.json") -Value '{"port":8710,"authToken":""}' -NoNewline
  New-Item -ItemType Directory -Force (Join-Path $state "mod-library\abc") | Out-Null
  Set-Content -Path (Join-Path $state "mod-library\abc\a.jar") -Value "JAR-CONTENT-THAT-MUST-SURVIVE" -NoNewline
  $stateBefore = Get-StateManifest $state
  Info "seeded state directory: $($stateBefore.Count) files under $state"

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
  # /TASKS="" deselects both post-install actions, so nothing interactive runs
  # and no scheduled task or firewall rule is created on this machine.
  $installLog = Join-Path $work "install.log"
  $p = Start-Process -FilePath $setup -Wait -PassThru -ArgumentList @(
    "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/DIR=$dest", "/TASKS=""""", "/LOG=$installLog")
  $installIdle = Wait-SetupIdle 180000
  Check "install finished (no setup process left running)" $installIdle ""
  Check "silent install exit 0" ($p.ExitCode -eq 0) "exit=$($p.ExitCode)"

  # The session preflight runs before anything is stopped or copied and aborts
  # an unattended install outright when a game session may be live. Reaching
  # the installed files at all means it returned 0, but say so explicitly -- an
  # abort here would be the gate working, not a harness bug.
  $installLogText = if (Test-Path $installLog) { Get-Content $installLog -Raw } else { "" }
  Check "session preflight passed (install was not aborted)" ($installLogText -notmatch 'aborting unattended install') ""
  @(Get-Content $installLog -ErrorAction SilentlyContinue | Where-Object { $_ -match 'RunSessionPreflight|Setup version|Setup aborted' } | Select-Object -First 3) | ForEach-Object { Info $_ }

  foreach ($f in @("dist\index.js","dist\setup-cli.js","dist\migrate-cli.js","node\node.exe","start-daemon.cmd","setup.cmd","migrate.cmd","register-task.ps1","config.example.json","package.json")) {
    Check "installed: $f" (Test-Path (Join-Path $dest $f)) ""
  }
  Check "node_modules installed" (Test-Path (Join-Path $dest "node_modules\fastify")) ""
  # dontcopy in [Files]: an install-time tool, extracted to {tmp} and never
  # part of the daemon, so finding it in {app} means the flag was lost.
  Check "preflight.ps1 not installed into {app}" (-not (Test-Path (Join-Path $dest "preflight.ps1"))) ""
  Check "Add/Remove Programs entry registered" ((Get-ArpEntries).Count -eq 1) "$((Get-ArpEntries) -join ', ')"
  if (-not $isElevated) {
    Check "[Dirs] state folder created (redirected for this harness)" (Test-Path $dirsAnchor) ""
  }
  Check "install did not modify the state directory" (((Get-StateManifest $state) -join "`n") -eq ($stateBefore -join "`n")) ""

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

  # The launcher test writes boot-refusal.txt; it must land in the throwaway
  # run state, not in the state directory whose contents are under assertion.
  Check "launcher refusal landed in the scratch run state" (Test-Path (Join-Path $runState "boot-refusal.txt")) ""
  Check "state directory still unmodified after the launcher test" (((Get-StateManifest $state) -join "`n") -eq ($stateBefore -join "`n")) ""

  # --------------------------------------------------------------- uninstall
  Write-Host ""
  Write-Host "--- silent uninstall ---"
  $unins = Join-Path $dest "unins000.exe"
  Check "uninstaller present" (Test-Path $unins) ""
  $u = Start-Process -FilePath $unins -Wait -PassThru -ArgumentList @("/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART")
  # unins000.exe re-execs as _iuXXXX.tmp and returns immediately, so its exit
  # code is the launcher's, not the uninstall's. Waiting for the family to go
  # quiet is what makes the assertions below mean anything.
  $uninstallIdle = Wait-SetupIdle 180000
  Check "uninstall finished (no uninstaller process left running)" $uninstallIdle "launcher exit=$($u.ExitCode)"
  Check "install directory removed" (-not (Test-Path (Join-Path $dest "dist\index.js"))) ""
  Check "Add/Remove Programs entry removed" ((Get-ArpEntries).Count -eq 0) "$((Get-ArpEntries) -join ', ')"
  Check "Start Menu group removed" ((@($startMenuGroups | Where-Object { Test-Path $_ })).Count -eq 0) ""

  # The assertion this whole script exists for.
  Write-Host ""
  $stateAfter = Get-StateManifest $state
  Check "STATE DIRECTORY SURVIVED" (Test-Path (Join-Path $state "config.json")) ""
  Check "MOD LIBRARY SURVIVED" ((Get-Content (Join-Path $state "mod-library\abc\a.jar") -Raw -ErrorAction SilentlyContinue) -eq "JAR-CONTENT-THAT-MUST-SURVIVE") ""
  Check "STATE DIRECTORY BYTE-IDENTICAL ACROSS INSTALL AND UNINSTALL" (($stateAfter -join "`n") -eq ($stateBefore -join "`n")) "$($stateBefore.Count) files before, $($stateAfter.Count) after"

  # ------------------------------------------------------------- measurement
  # Not a Check(): measured and reported, never asserted. The installer's
  # informational message boxes are SuppressibleMsgBox, which only honours its
  # Default answer under /SUPPRESSMSGBOXES -- and every run above passes that
  # flag. That is exactly the shape of harness that certifies the one
  # configuration where a thing works, so measure the other one.
  Write-Host ""
  Write-Host "--- measurement: silent switches WITHOUT /SUPPRESSMSGBOXES ---"
  $env:NECESSE_MANAGER_DATA = $state2
  $m1Log = Join-Path $work "measure-install.log"
  $m1 = Start-Process -FilePath $setup -PassThru -ArgumentList @(
    "/VERYSILENT", "/NORESTART", "/DIR=$dest2", "/TASKS=""""", "/LOG=$m1Log")
  $m1Done = $m1.WaitForExit(120000)
  if ($m1Done) { $m1Done = Wait-SetupIdle 15000 }
  if ($m1Done) {
    $m1.Refresh()
    Write-Host "MEASUREMENT install   /VERYSILENT alone: COMPLETED, exit=$($m1.ExitCode)"
  } else {
    Write-Host "MEASUREMENT install   /VERYSILENT alone: DID NOT COMPLETE within 120s - killed"
    if (Test-Path $m1Log) {
      Write-Host "  last lines of its Inno log, i.e. where it stopped:"
      Get-Content $m1Log -Tail 8 | ForEach-Object { Write-Host "    $_" }
    }
    Stop-SetupProcesses
  }

  # The install path above reaches no message box when /TASKS="" is passed. The
  # one that always fires is on the uninstall side (usPostUninstall, "the
  # daemon has been removed"), so measure that too or the measurement misses
  # the case it was added for.
  $unins2 = Join-Path $dest2 "unins000.exe"
  if (Test-Path $unins2) {
    $m2 = Start-Process -FilePath $unins2 -PassThru -ArgumentList @("/VERYSILENT","/NORESTART")
    $m2.WaitForExit(10000) | Out-Null
    if (Wait-SetupIdle 120000) { Write-Host "MEASUREMENT uninstall /VERYSILENT alone: COMPLETED" }
    else {
      Write-Host "MEASUREMENT uninstall /VERYSILENT alone: DID NOT COMPLETE within 120s - killed"
      Stop-SetupProcesses
    }
  } else {
    Write-Host "MEASUREMENT uninstall /VERYSILENT alone: SKIPPED (no uninstaller; the install above did not get that far)"
  }

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
