; Installer for the Necesse Server Manager daemon.
;
; Built against a directory staged by installer\stage-daemon.ps1 plus
; installer\fetch-node.ps1, so the payload here is exactly the release zip's
; contents plus a private node\node.exe.
;
; Required defines:
;   StageDir   absolute path to the staged payload
;   AppVersion x.y.z, used in the output filename and Add/Remove Programs
;   OutDir     absolute path to write the installer into

#ifndef StageDir
  #error StageDir is not defined. Pass /DStageDir=<absolute path>.
#endif
#ifndef AppVersion
  #error AppVersion is not defined. Pass /DAppVersion=<x.y.z>.
#endif
#ifndef OutDir
  #error OutDir is not defined. Pass /DOutDir=<absolute path>.
#endif

[Setup]
; Fixed forever: Inno recognises an existing install by this, which is what
; makes upgrades replace in place instead of installing a second copy.
AppId={{7B1B3E2A-9C4D-4F2E-A6D1-2E5C9F0B4A17}
AppName=Necesse Server Manager (daemon)
AppVersion={#AppVersion}
AppPublisher=Jeff Pegg
DefaultDirName={autopf}\Necesse Server Manager
DefaultGroupName=Necesse Server Manager
DisableProgramGroupPage=yes
; The scheduled task and the firewall rule both need elevation, and so does
; writing to Program Files. Asking once up front beats failing halfway.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=necesse-daemon-v{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Necesse Server Manager (daemon)

[Dirs]
; uninsneveruninstall makes explicit the guarantee this whole design depends
; on: Inno must never remove this directory on uninstall, full stop, rather
; than relying on the default "only remove if empty and not pre-existing"
; behaviour to happen to be safe. Created here only so the Start Menu "Open
; state folder" shortcut is valid before the daemon has ever run - harmless
; either way, since the legacy-state check only treats the directory as
; populated when it actually contains something.
;
; FINDING D fix: this used to be the literal constant
; {commonappdata}\NecesseServerManager, which is resolved by Inno itself and
; cannot see NECESSE_MANAGER_DATA. On a box using the override that created a
; stray empty C:\ProgramData\NecesseServerManager which uninsneveruninstall
; then guaranteed would never be cleaned up again. {code:StateDirConst} routes
; it through the same resolver every other reader of the state directory uses.
Name: "{code:StateDirConst}"; Flags: uninsneveruninstall

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; dontcopy: an install-time tool, not part of the daemon, so it must never
; land in {app}. Pulled out at runtime with ExtractTemporaryFile and run from
; {tmp} instead.
Source: "{#SourcePath}\preflight.ps1"; DestDir: "{tmp}"; Flags: dontcopy

[Icons]
Name: "{group}\Setup (configure the daemon)"; Filename: "{app}\setup.cmd"
Name: "{group}\Start daemon"; Filename: "{app}\start-daemon.cmd"
Name: "{group}\Register boot task"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\register-task.ps1"""
; FINDING D fix: same reason as [Dirs] above. Hardcoded, this shortcut opened
; an empty decoy instead of the operator's actual state directory.
Name: "{group}\Open state folder"; Filename: "{code:StateDirConst}"

[Tasks]
Name: "runsetup"; Description: "Run the setup wizard now (opens a console window)"
; FINDING G fix, and it only became necessary because of the FINDING A fix in
; CurPageChanged. While that procedure still ran under silence it computed this
; checkbox from ScheduledTaskExists() or (not ConfigExists()), which is OFF on a
; configured machine that has deliberately never registered a task. Once it
; correctly stopped running under silence, an unattended "setup.exe /VERYSILENT"
; with no /TASKS switch fell back to this section's defaults, and a default of
; checked would select boottask on exactly that machine - find config.json,
; run register-task.ps1, and hand the operator a Scheduled Task and an open
; port 8710 they had deliberately chosen not to have.
;
; unchecked makes the unattended default "do not touch the boot configuration",
; which is the only safe default for a switch nobody was there to answer.
; Interactive runs are unaffected: CurPageChanged sets both checkboxes
; explicitly on wpSelectTasks, overriding whatever the default here was.
Name: "boottask"; Description: "Start the daemon automatically at boot, and open its firewall port"; Flags: unchecked

[Code]
const
  TaskName = 'NecesseDaemon';

// FINDING I fix: matches daemon/src/state-dir.ts's precedence exactly -
// NECESSE_MANAGER_DATA overrides %PROGRAMDATA%\NecesseServerManager when set.
// Hardcoding %PROGRAMDATA% here made ConfigExists() (which gates task
// registration and the checkbox defaults) look at the wrong directory on any
// box using the override.
function StateDir(): String;
var
  DataDirOverride: String;
begin
  DataDirOverride := GetEnv('NECESSE_MANAGER_DATA');
  if Trim(DataDirOverride) <> '' then
    Result := DataDirOverride
  else
    Result := ExpandConstant('{commonappdata}\NecesseServerManager');
end;

function ConfigExists(): Boolean;
begin
  Result := FileExists(StateDir() + '\config.json');
end;

// FINDING D fix: the {code:...} form of the above, for [Dirs] and [Icons].
// Those sections are resolved by Inno's own constant expander, which knows
// nothing about NECESSE_MANAGER_DATA; this is the only way to make them agree
// with StateDir(). The Param argument is required by the {code:} calling
// convention and is unused.
function StateDirConst(Param: String): String;
begin
  Result := StateDir();
end;

function YesNo(B: Boolean): String;
begin
  if B then Result := 'yes' else Result := 'no';
end;

// FINDING C fix: never block an unattended run on a dialog.
//
// SuppressibleMsgBox only honours its Default answer when the operator also
// passed /SUPPRESSMSGBOXES. Measured directly with MB_OK under plain
// /VERYSILENT: it does not return the Default and it does not return at all -
// it shows a real modal box, invisible because /VERYSILENT hides the wizard,
// and waits forever for a click that is never coming. Requiring a second flag
// to avoid an unbounded hang is not an acceptable contract for anyone
// scripting this install, so silence is decided here explicitly, the same way
// RunSessionPreflight already decides it, and the text goes to the log.
//
// Install and uninstall need separate procedures because WizardSilent and
// UninstallSilent are separate context-specific functions; neither is
// meaningful on the other side.
procedure NotifyInstall(const Text: String; Kind: TMsgBoxType);
begin
  if WizardSilent then
    Log('Notice (silent, not shown): ' + Text)
  else
    MsgBox(Text, Kind, MB_OK);
end;

procedure NotifyUninstall(const Text: String; Kind: TMsgBoxType);
begin
  if UninstallSilent then
    Log('Notice (silent, not shown): ' + Text)
  else
    MsgBox(Text, Kind, MB_OK);
end;

function ScheduledTaskExists(): Boolean;
var
  Code: Integer;
begin
  Result := Exec('schtasks.exe', '/query /tn "' + TaskName + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

// Runs preflight.ps1 (extracted fresh each call) and captures its output via
// plain OS-level redirection - confirmed by hand to land as single-byte
// ASCII, which is what LoadStringFromFile expects - so Pascal can show the
// operator exactly what the script saw rather than just a bare exit code.
function RunPreflight(const Mode: String; var OutputText: String): Integer;
var
  ResultCode: Integer;
  OutFile: String;
  RawOutput: AnsiString;
begin
  ExtractTemporaryFile('preflight.ps1');
  OutFile := ExpandConstant('{tmp}') + '\preflight-' + Mode + '.txt';
  if FileExists(OutFile) then DeleteFile(OutFile);
  if Exec(ExpandConstant('{cmd}'),
          '/c powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\preflight.ps1') +
          '" -Mode ' + Mode + ' > "' + OutFile + '" 2>&1',
          '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    // LoadStringFromFile's out param is AnsiString, not String (Inno 6's
    // Pascal Script strings are Unicode) - a var parameter needs an exact
    // type match, so this reads into a temp and converts by assignment.
    // The redirected output was confirmed by hand to be plain single-byte
    // ASCII, so that conversion is lossless here.
    if FileExists(OutFile) then
    begin
      LoadStringFromFile(OutFile, RawOutput);
      OutputText := RawOutput;
    end
    else OutputText := '';
    Result := ResultCode;
  end
  else
  begin
    OutputText := 'preflight.ps1 (' + Mode + ' mode) could not be launched.';
    Result := 3;
  end;
end;

// FINDING A fix: gates every install/upgrade on the daemon's own reported
// game-server state, before anything is stopped or copied. A live session
// killed by StopDaemonTask below cannot be saved - the daemon installs no
// signal handler - so this has to run first and be able to refuse.
//
// FINDING A2 fix: this used to lean on SuppressibleMsgBox's Default to fail
// closed under silence. Only /SUPPRESSMSGBOXES makes it honour Default, and
// Task 4's harness happens to pass that flag, so the harness would stay green
// while plain /SILENT was unprotected. Silence is now decided here,
// explicitly, with WizardSilent, before any dialog exists to get the wrong
// answer from - an unattended run always aborts on a non-zero check rather
// than proceeding on an outcome nobody actually confirmed. A probe installer
// confirmed Abort here works: aborted with exit code 3, ssPostInstall and
// ssDone never reached.
//
// Correction to an earlier claim in this comment: it said SuppressibleMsgBox
// returns the affirmative button under plain /VERYSILENT, logged as IDYES.
// Re-measured with MB_OK - it returns nothing at all. It shows a real modal
// box that /VERYSILENT merely makes invisible, and blocks forever. That is
// worse than answering wrongly, and is why NotifyInstall/NotifyUninstall
// above now suppress every remaining informational box under silence rather
// than relying on a second command-line flag.
//
// FINDING I fold-in: a check that could not determine anything (including a
// 401 - the daemon IS answering, just not to this token, which proves
// something is live on that port) is treated the same as "may be live", not
// as safe to proceed. Interactively this asks; under silence it aborts.
procedure RunSessionPreflight();
var
  Output: String;
  Response: Integer;
  CheckCode: Integer;
begin
  CheckCode := RunPreflight('Check', Output);
  if CheckCode = 0 then Exit;

  if WizardSilent then
  begin
    Log('RunSessionPreflight: aborting unattended install/upgrade, CheckCode=' + IntToStr(CheckCode) + ': ' + Output);
    Abort;
  end;

  if CheckCode = 2 then
    Response := MsgBox(
      'A game session may still be running:' + #13#10#13#10 + Output + #13#10#13#10 +
      'Continuing will stop the daemon, which has no way to ask it to save first. ' +
      'Confirm nobody is playing before continuing.' + #13#10#13#10 +
      'Continue anyway?',
      mbConfirmation, MB_YESNO)
  else
    Response := MsgBox(
      'Could not determine whether a game session is running:' + #13#10#13#10 + Output + #13#10#13#10 +
      'A rejected or unreachable check does not prove nothing is running. Stop the daemon yourself first if you are not sure, ' +
      'or cancel and run this installer again without a silent switch so you can decide interactively.' + #13#10#13#10 +
      'Continue anyway?',
      mbError, MB_YESNO);

  if Response <> IDYES then Abort;
end;

// Stopping is not optional on an upgrade: node.exe cannot be overwritten
// while it is running, and a surviving process keeps the port, so the daemon
// that starts afterwards would die on EADDRINUSE while the old one kept
// answering. Only reached once RunSessionPreflight above has already
// established (or the operator has already confirmed) that this is safe.
//
// FINDING C/D fix: ending the task is not sufficient by itself - the process
// it launched may take a moment to release the port, and a daemon started by
// hand from the "Start daemon" shortcut has no task to end at all - so
// preflight.ps1's Stop mode polls the task state and then the port the same
// way scripts/03-register-task.ps1 already does, and as a last resort ends
// whatever node.exe process still owns the port.
procedure StopDaemonTask();
var
  Code: Integer;
  Output: String;
begin
  if ScheduledTaskExists() then
    Exec('schtasks.exe', '/end /tn "' + TaskName + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);

  if RunPreflight('Stop', Output) <> 0 then
    NotifyInstall(
      'The existing daemon may still be running:' + #13#10#13#10 + Output + #13#10#13#10 +
      'If copying files fails next, stop it manually (Task Manager, end any node.exe using the daemon''s port) and re-run this installer.',
      mbError);
end;

// The boot-task checkbox defaults to what the machine already has, not to a
// blanket yes. Someone who deliberately runs the daemon by hand should not
// acquire a boot task because they accepted a default on an upgrade screen.
//
// FINDING A fix, and the precedence here is the opposite of what this comment
// used to claim. CurPageChanged(wpSelectTasks) fires under /VERYSILENT even
// though the page is never displayed, so these WizardSelectTasks calls ran
// last and overwrote whatever /TASKS had set. Measured on Inno 6.7.3: with
// this procedure absent, /TASKS="" deselects both tasks exactly as documented;
// with it present, every form of /TASKS and /MERGETASKS was silently ignored,
// including /TASKS=nosuchtask. So a scripted install could not turn the boot
// task off, and any silent run with a config.json present would execute
// register-task.ps1 whether or not it was asked to.
//
// Bailing out under silence restores the documented behaviour: the command
// line wins when there is no one to show a checkbox to, and these defaults
// apply only to the page an operator can actually see.
procedure CurPageChanged(CurPageID: Integer);
begin
  if WizardSilent then Exit;

  if CurPageID = wpSelectTasks then
  begin
    if ConfigExists() then
      WizardSelectTasks('!runsetup')
    else
      WizardSelectTasks('runsetup');

    if ScheduledTaskExists() or (not ConfigExists()) then
      WizardSelectTasks('boottask')
    else
      WizardSelectTasks('!boottask');
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if CurStep = ssInstall then
  begin
    RunSessionPreflight();
    StopDaemonTask();
  end
  else if CurStep = ssPostInstall then
  begin
    // Logged unconditionally. "Why did my boot task not get registered" is the
    // first question an unattended install raises, and in a silent run every
    // other trace of this decision is invisible. It is also the only
    // elevation-independent way to observe the choice: on a machine that
    // cannot register a task, "no task exists afterwards" is true whether the
    // branch was skipped or merely failed.
    Log('ssPostInstall: runsetup=' + YesNo(WizardIsTaskSelected('runsetup')) +
        ' boottask=' + YesNo(WizardIsTaskSelected('boottask')) +
        ' configExists=' + YesNo(ConfigExists()) +
        ' silent=' + YesNo(WizardSilent));

    if WizardIsTaskSelected('runsetup') and (not ConfigExists()) then
    begin
      // Visible and waited on: the wizard is interactive and cannot be
      // scripted, so there is nothing to do but show it and let the operator
      // answer. Running it hidden would hang forever on the first prompt.
      //
      // FINDING B fix, two defects in one line. It was reached under silence
      // (see CurPageChanged above - /TASKS could not deselect runsetup), where
      // setup.cmd inherits no console: its first prompt reads an already-closed
      // stdin and node dies with ERR_USE_AFTER_CLOSE, exit 1, having written no
      // config.json. And this Exec's result was discarded, so the installer
      // then reported a completely successful install of a daemon that had
      // never been configured and could not boot. Offered only interactively
      // now, and its outcome is no longer assumed.
      if WizardSilent then
        Log('ssPostInstall: silent install - not launching the interactive setup wizard. No config.json was created; run setup.cmd afterwards.')
      // Two distinct outcomes, kept apart: when Exec returns False it never
      // assigned Code, so folding them together printed whatever happened to
      // be in that variable as an exit status.
      else if not Exec(ExpandConstant('{app}\setup.cmd'), '', ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code) then
        NotifyInstall('The daemon was installed, but the setup wizard could not be started.' + #13#10#13#10 +
               'No configuration was created. Run "Setup" from the Start Menu before starting the daemon.',
               mbError)
      else if Code <> 0 then
        NotifyInstall('The daemon was installed, but the setup wizard did not complete (exit ' + IntToStr(Code) + ').' + #13#10#13#10 +
               'No configuration was created. Run "Setup" from the Start Menu before starting the daemon.',
               mbError);
    end;

    // Ordering is load-bearing. Registering the task before a config exists
    // starts a daemon that refuses to boot, and register-task.ps1 ends with a
    // health check - so it would report failure on a registration that in fact
    // worked. Gate on the config actually being there now.
    if WizardIsTaskSelected('boottask') then
    begin
      if ConfigExists() then
      begin
        if not Exec('powershell.exe',
                    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\register-task.ps1') + '"',
                    ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code) or (Code <> 0) then
          NotifyInstall('The daemon was installed, but registering the boot task did not complete.' + #13#10#13#10 +
                 'You can retry it from the Start Menu (Register boot task). If the daemon refuses to start, it writes the reason to:' + #13#10 +
                 StateDir() + '\boot-refusal.txt',
                 mbError);
      end
      else
        // FINDING F fix: reported whether or not "run setup" was even
        // selected - a boot task selected on its own, with no config to back
        // it, must not fail silently just because RanSetup was false.
        NotifyInstall('The boot task was not registered because no configuration exists yet at ' +
               StateDir() + '\config.json.' + #13#10#13#10 +
               'Run "Setup" from the Start Menu when you are ready, then "Register boot task".',
               mbInformation);
    end;
  end;
end;

// FINDING D fix, uninstall side, extended by FINDING A3/I this round:
// ExtractTemporaryFile only works during install (it extracts from the
// setup's own [Files] payload, which the uninstaller does not carry - no
// mention of uninstall use in Inno's own docs for the function, and the
// uninstaller genuinely has no access to that payload), so preflight.ps1
// itself is not reachable here. This is a self-contained equivalent that
// combines both of preflight.ps1's modes into one script, gated by -Force:
// without it, checks /api/status first and refuses (exit 2 live / exit 3
// cannot-determine) before touching anything; with it, skips straight to the
// task-state poll, port poll, and ending whatever node.exe still owns the
// port. Verified directly against a fake HTTP listener standing in for the
// daemon (see task-3-report.md) - all four exit codes (0/1/2/3) and the
// -Force bypass behaved as designed.
//
// FINDING I: resolves NECESSE_MANAGER_DATA the same way preflight.ps1 does,
// for the same reason - hardcoding %PROGRAMDATA% here would read the wrong
// config.json and fail open on an overridden box.
function UninstallPreflightScript(): String;
var
  Q: String;
begin
  Q := #39;
  Result :=
    '[CmdletBinding()]' + #13#10 +
    'param([switch]$Force)' + #13#10 +
    '$stateDir = $env:NECESSE_MANAGER_DATA' + #13#10 +
    'if (-not $stateDir -or $stateDir.Trim().Length -eq 0) {' + #13#10 +
    '  $stateDir = $null' + #13#10 +
    '  if ($env:PROGRAMDATA) { $stateDir = Join-Path $env:PROGRAMDATA ' + Q + 'NecesseServerManager' + Q + ' }' + #13#10 +
    '}' + #13#10 +
    '$port = 8710' + #13#10 +
    '$authToken = $null' + #13#10 +
    'if ($stateDir) {' + #13#10 +
    '  $cfgFile = Join-Path $stateDir ' + Q + 'config.json' + Q + #13#10 +
    '  if (Test-Path $cfgFile) {' + #13#10 +
    '    try {' + #13#10 +
    '      $c = ((Get-Content $cfgFile -Raw) -replace "^\uFEFF", "") | ConvertFrom-Json' + #13#10 +
    '      if ($c.port) { $port = [int]$c.port }' + #13#10 +
    '      $authToken = $c.authToken' + #13#10 +
    '    } catch {}' + #13#10 +
    '  }' + #13#10 +
    '}' + #13#10 +
    'if (-not $Force) {' + #13#10 +
    '  $headers = @{}' + #13#10 +
    '  if ($authToken) { $headers[' + Q + 'Authorization' + Q + '] = "Bearer $authToken" }' + #13#10 +
    '  try {' + #13#10 +
    '    $status = Invoke-RestMethod "http://localhost:$port/api/status" -Headers $headers -TimeoutSec 10' + #13#10 +
    '    if ($status.state -ne ' + Q + 'stopped' + Q + ') {' + #13#10 +
    '      $world = $status.world' + #13#10 +
    '      if (-not $world) { $world = ' + Q + '(none)' + Q + ' }' + #13#10 +
    '      Write-Output "STATE=$($status.state) WORLD=$world"' + #13#10 +
    '      exit 2' + #13#10 +
    '    }' + #13#10 +
    '  } catch {' + #13#10 +
    '    $refused = $false' + #13#10 +
    '    $ex = $_.Exception' + #13#10 +
    '    while ($ex) {' + #13#10 +
    '      if ($ex.Message -match ' + Q + 'actively refused' + Q + ' -or $ex.Message -match ' + Q + 'No connection could be made' + Q + ' -or $ex.GetType().Name -eq ' + Q + 'SocketException' + Q + ') {' + #13#10 +
    '        $refused = $true' + #13#10 +
    '        break' + #13#10 +
    '      }' + #13#10 +
    '      $ex = $ex.InnerException' + #13#10 +
    '    }' + #13#10 +
    '    if (-not $refused) {' + #13#10 +
    '      Write-Output "CANNOT_DETERMINE: GET http://localhost:$port/api/status failed: $($_.Exception.Message)"' + #13#10 +
    '      exit 3' + #13#10 +
    '    }' + #13#10 +
    '  }' + #13#10 +
    '}' + #13#10 +
    '$task = Get-ScheduledTask -TaskName ' + Q + 'NecesseDaemon' + Q + ' -ErrorAction SilentlyContinue' + #13#10 +
    'if ($task -and $task.State -eq ' + Q + 'Running' + Q + ') {' + #13#10 +
    '  Stop-ScheduledTask -TaskName ' + Q + 'NecesseDaemon' + Q + ' -ErrorAction SilentlyContinue' + #13#10 +
    '  $deadline = (Get-Date).AddSeconds(20)' + #13#10 +
    '  while ((Get-Date) -lt $deadline) {' + #13#10 +
    '    $t = Get-ScheduledTask -TaskName ' + Q + 'NecesseDaemon' + Q + ' -ErrorAction SilentlyContinue' + #13#10 +
    '    if (-not $t -or $t.State -ne ' + Q + 'Running' + Q + ') { break }' + #13#10 +
    '    Start-Sleep -Milliseconds 500' + #13#10 +
    '  }' + #13#10 +
    '}' + #13#10 +
    '$portDeadline = (Get-Date).AddSeconds(15)' + #13#10 +
    '$conn = $null' + #13#10 +
    'while ((Get-Date) -lt $portDeadline) {' + #13#10 +
    '  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue' + #13#10 +
    '  if (-not $conn) { break }' + #13#10 +
    '  Start-Sleep -Milliseconds 500' + #13#10 +
    '}' + #13#10 +
    'if ($conn) {' + #13#10 +
    '  foreach ($c in @($conn)) {' + #13#10 +
    '    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue' + #13#10 +
    '    if ($p -and $p.ProcessName -eq ' + Q + 'node' + Q + ') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }' + #13#10 +
    '  }' + #13#10 +
    '  Start-Sleep -Milliseconds 500' + #13#10 +
    '  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue' + #13#10 +
    '}' + #13#10 +
    'if ($conn) {' + #13#10 +
    '  Write-Output "STILL_LISTENING: port $port is still held after stop attempts."' + #13#10 +
    '  exit 1' + #13#10 +
    '}' + #13#10 +
    'Write-Output "STOPPED: port $port is free."' + #13#10 +
    'exit 0';
end;

// Mirrors RunPreflight (install side): writes the script fresh each call
// (SaveStringToFile works in both Setup and Uninstall, unlike
// ExtractTemporaryFile), captures output via the same OS-level redirection,
// same AnsiString-to-String conversion for LoadStringFromFile.
function RunUninstallPreflight(const ExtraArgs: String; var OutputText: String): Integer;
var
  ResultCode: Integer;
  ScriptPath, OutFile: String;
  RawOutput: AnsiString;
begin
  ScriptPath := ExpandConstant('{tmp}') + '\uninstall-preflight.ps1';
  SaveStringToFile(ScriptPath, UninstallPreflightScript(), False);
  OutFile := ExpandConstant('{tmp}') + '\uninstall-preflight-out.txt';
  if FileExists(OutFile) then DeleteFile(OutFile);
  if Exec(ExpandConstant('{cmd}'),
          '/c powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath + '" ' + ExtraArgs +
          ' > "' + OutFile + '" 2>&1',
          '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if FileExists(OutFile) then
    begin
      LoadStringFromFile(OutFile, RawOutput);
      OutputText := RawOutput;
    end
    else OutputText := '';
    Result := ResultCode;
  end
  else
  begin
    OutputText := 'uninstall preflight script could not be launched.';
    Result := 3;
  end;
end;

// FINDING A3 fix: the uninstall-side equivalent of RunSessionPreflight, using
// UninstallSilent instead of WizardSilent - they are separate, context-
// specific functions (WizardSilent is not meaningful here). Same contract:
// silence aborts outright on a non-zero code, interactive asks and aborts on
// anything but Yes.
function ConfirmUninstallProceed(CheckCode: Integer; const Output: String): Boolean;
var
  Response: Integer;
begin
  if CheckCode = 0 then
  begin
    Result := True;
    Exit;
  end;

  if UninstallSilent then
  begin
    Log('ConfirmUninstallProceed: aborting unattended uninstall, CheckCode=' + IntToStr(CheckCode) + ': ' + Output);
    Result := False;
    Exit;
  end;

  if CheckCode = 2 then
    Response := MsgBox(
      'A game session may still be running:' + #13#10#13#10 + Output + #13#10#13#10 +
      'Continuing will stop the daemon, which has no way to ask it to save first. ' +
      'Confirm nobody is playing before continuing.' + #13#10#13#10 +
      'Continue with uninstall anyway?',
      mbConfirmation, MB_YESNO)
  else
    Response := MsgBox(
      'Could not determine whether a game session is running:' + #13#10#13#10 + Output + #13#10#13#10 +
      'A rejected or unreachable check does not prove nothing is running. Stop the daemon yourself first if you are not sure, ' +
      'or cancel and run this uninstaller again without a silent switch so you can decide interactively.' + #13#10#13#10 +
      'Continue with uninstall anyway?',
      mbError, MB_YESNO);

  Result := (Response = IDYES);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  Output: String;
  StopCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    StopCode := RunUninstallPreflight('', Output);
    if StopCode <> 0 then
    begin
      if (StopCode = 2) or (StopCode = 3) then
      begin
        if not ConfirmUninstallProceed(StopCode, Output) then Abort;
        // The check-only run above refused before touching anything, so the
        // operator's (or an interactive-only, since silence already aborted)
        // confirmation has to be followed by an actual, forced stop.
        StopCode := RunUninstallPreflight('-Force', Output);
      end;

      if StopCode = 1 then
        NotifyUninstall(
          'The existing daemon may still be running:' + #13#10#13#10 + Output + #13#10#13#10 +
          'Files may fail to delete next. If so, stop it manually and re-run the uninstaller.',
          mbError);
    end;

    // FINDING H fix: schtasks /delete on a missing task, and
    // Remove-NetFirewallRule on a missing rule, both exit non-zero even with
    // -ErrorAction SilentlyContinue (verified on this box: -ErrorAction
    // suppresses the message, not the exit code) - so an install where "boot
    // task" was never selected popped two false-failure dialogs on uninstall.
    // Both checks are now existence-gated so a failure dialog means an actual
    // failure.
    if ScheduledTaskExists() then
    begin
      if not (Exec('schtasks.exe', '/delete /tn "' + TaskName + '" /f', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0)) then
        NotifyUninstall('Could not delete the scheduled task ' + TaskName + '. If it still exists, remove it manually from Task Scheduler.',
          mbError);
    end;

    // FINDING B fix: netsh's "delete rule name=" matches DisplayName, not the
    // Name register-task.ps1 actually creates the rule with
    // (NecesseDaemon-Inbound), so it never matched anything and the port
    // stayed open forever after uninstall. Remove-NetFirewallRule matches by
    // Name. The existence check is inside the same command (not a separate
    // Exec) so "not found" cannot itself report as a failure.
    if not (Exec('powershell.exe',
                 '-NoProfile -Command "if (Get-NetFirewallRule -Name ' + TaskName + '-Inbound -ErrorAction SilentlyContinue) ' +
                 '{ Remove-NetFirewallRule -Name ' + TaskName + '-Inbound -ErrorAction Stop }"',
                 '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0)) then
      NotifyUninstall('Could not remove the firewall rule ' + TaskName + '-Inbound. If it still exists, remove it manually from Windows Defender Firewall.',
        mbError);
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    // Deliberately NOT deleted, and deliberately not offered as a checkbox.
    // mod-library\ is the only copy of every uploaded and hand-placed jar,
    // and uninstall is the screen people click through fastest.
    //
    // FINDING E fix, completed by FINDING C: SuppressibleMsgBox was not enough.
    // This box fires on every uninstall, so it hung any /VERYSILENT uninstall
    // that did not also pass /SUPPRESSMSGBOXES - measured, and it was the last
    // unconditional blocker on either path. NotifyUninstall logs it instead.
    NotifyUninstall('The daemon has been removed.' + #13#10#13#10 +
           'Your worlds are untouched. Any configuration and mod library you had are still at:' + #13#10 +
           StateDir() + #13#10#13#10 +
           'Delete that folder yourself if you want it gone - it holds the only copy of any mod jar you uploaded by hand.',
           mbInformation);
  end;
end;
