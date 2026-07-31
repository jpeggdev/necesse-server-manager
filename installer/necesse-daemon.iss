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
Name: "{commonappdata}\NecesseServerManager"; Flags: uninsneveruninstall

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
Name: "{group}\Open state folder"; Filename: "{commonappdata}\NecesseServerManager"

[Tasks]
Name: "runsetup"; Description: "Run the setup wizard now (opens a console window)"
Name: "boottask"; Description: "Start the daemon automatically at boot, and open its firewall port"

[Code]
const
  TaskName = 'NecesseDaemon';

function StateDir(): String;
begin
  Result := ExpandConstant('{commonappdata}\NecesseServerManager');
end;

function ConfigExists(): Boolean;
begin
  Result := FileExists(StateDir() + '\config.json');
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
// Exit code 2 (a session may be live) defaults to IDNO: SuppressibleMsgBox
// returns that Default without showing anything under /SILENT or
// /VERYSILENT, so an unattended upgrade fails closed instead of being the
// thing that eats a save. Exit code 3 (cannot determine) only warns, because
// there is no stronger offline signal to act on and it must not block an
// install outright.
procedure RunSessionPreflight();
var
  Output: String;
  Response: Integer;
  CheckCode: Integer;
begin
  CheckCode := RunPreflight('Check', Output);
  if CheckCode = 2 then
  begin
    Response := SuppressibleMsgBox(
      'A game session may still be running:' + #13#10#13#10 + Output + #13#10#13#10 +
      'Continuing will stop the daemon, which has no way to ask it to save first. ' +
      'Confirm nobody is playing before continuing.' + #13#10#13#10 +
      'Continue anyway?',
      mbConfirmation, MB_YESNO, IDNO);
    if Response <> IDYES then Abort;
  end
  else if CheckCode <> 0 then
  begin
    SuppressibleMsgBox(
      'Could not determine whether a game session is running:' + #13#10#13#10 + Output + #13#10#13#10 +
      'Continuing anyway. If a session is live, stop it yourself before this install goes further.',
      mbError, MB_OK, IDOK);
  end;
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
    SuppressibleMsgBox(
      'The existing daemon may still be running:' + #13#10#13#10 + Output + #13#10#13#10 +
      'If copying files fails next, stop it manually (Task Manager, end any node.exe using the daemon''s port) and re-run this installer.',
      mbError, MB_OK, IDOK);
end;

// The boot-task checkbox defaults to what the machine already has, not to a
// blanket yes. Someone who deliberately runs the daemon by hand should not
// acquire a boot task because they accepted a default on an upgrade screen.
//
// Not exercised by any automated check: Task 4's silent install passes
// /TASKS="", which overrides whatever these defaults would have been. Only a
// real, non-silent run exercises this page.
procedure CurPageChanged(CurPageID: Integer);
begin
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
    if WizardIsTaskSelected('runsetup') and (not ConfigExists()) then
    begin
      // Visible and waited on: the wizard is interactive and cannot be
      // scripted, so there is nothing to do but show it and let the operator
      // answer. Running it hidden would hang forever on the first prompt.
      Exec(ExpandConstant('{app}\setup.cmd'), '', ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code);
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
          SuppressibleMsgBox('The daemon was installed, but registering the boot task did not complete.' + #13#10#13#10 +
                 'You can retry it from the Start Menu (Register boot task). If the daemon refuses to start, it writes the reason to:' + #13#10 +
                 StateDir() + '\boot-refusal.txt',
                 mbError, MB_OK, IDOK);
      end
      else
        // FINDING F fix: reported whether or not "run setup" was even
        // selected - a boot task selected on its own, with no config to back
        // it, must not fail silently just because RanSetup was false.
        SuppressibleMsgBox('The boot task was not registered because no configuration exists yet at ' +
               StateDir() + '\config.json.' + #13#10#13#10 +
               'Run "Setup" from the Start Menu when you are ready, then "Register boot task".',
               mbInformation, MB_OK, IDOK);
    end;
  end;
end;

// FINDING D fix, uninstall side: ExtractTemporaryFile only works during
// install (it extracts from the setup's own [Files] payload, which the
// uninstaller does not carry), so preflight.ps1 itself is not reachable here.
// This mirrors its Stop mode - task-state poll, then port poll, then end
// whatever node.exe still owns the port - as a self-contained script instead.
//
// Deliberately does not repeat FINDING A's live-session check: that gate was
// scoped to install/upgrade in this round, and the unconditional schtasks
// /end this replaces had no such gate either, so this is not a new gap this
// round introduced. Recorded as a residual risk in task-3-report.md - an
// uninstall during a live session is exactly as destructive as an upgrade
// during one, and deserves the same gate in a future round.
function UninstallStopScript(): String;
var
  Q: String;
begin
  Q := #39;
  Result :=
    '$port = 8710' + #13#10 +
    '$cfgFile = Join-Path $env:PROGRAMDATA ' + Q + 'NecesseServerManager\config.json' + Q + #13#10 +
    'if (Test-Path $cfgFile) {' + #13#10 +
    '  try {' + #13#10 +
    '    $c = ((Get-Content $cfgFile -Raw) -replace "^\uFEFF", "") | ConvertFrom-Json' + #13#10 +
    '    if ($c.port) { $port = [int]$c.port }' + #13#10 +
    '  } catch {}' + #13#10 +
    '}' + #13#10 +
    '$deadline = (Get-Date).AddSeconds(20)' + #13#10 +
    'while ((Get-Date) -lt $deadline) {' + #13#10 +
    '  $t = Get-ScheduledTask -TaskName ' + Q + 'NecesseDaemon' + Q + ' -ErrorAction SilentlyContinue' + #13#10 +
    '  if (-not $t -or $t.State -ne ' + Q + 'Running' + Q + ') { break }' + #13#10 +
    '  Start-Sleep -Milliseconds 500' + #13#10 +
    '}' + #13#10 +
    '$portDeadline = (Get-Date).AddSeconds(15)' + #13#10 +
    'while ((Get-Date) -lt $portDeadline) {' + #13#10 +
    '  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue' + #13#10 +
    '  if (-not $conn) { break }' + #13#10 +
    '  Start-Sleep -Milliseconds 500' + #13#10 +
    '}' + #13#10 +
    '$conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue' + #13#10 +
    'if ($conn) {' + #13#10 +
    '  foreach ($c in @($conn)) {' + #13#10 +
    '    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue' + #13#10 +
    '    if ($p -and $p.ProcessName -eq ' + Q + 'node' + Q + ') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }' + #13#10 +
    '  }' + #13#10 +
    '}';
end;

procedure StopUntaskedDaemonForUninstall();
var
  Code: Integer;
  ScriptPath: String;
begin
  ScriptPath := ExpandConstant('{tmp}') + '\uninstall-stop.ps1';
  SaveStringToFile(ScriptPath, UninstallStopScript(), False);
  Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Exec('schtasks.exe', '/end /tn "' + TaskName + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
    StopUntaskedDaemonForUninstall();

    // FINDING B/G fix: report failures instead of discarding Code - these are
    // the two calls that leave residue (a stale task, an open inbound port)
    // if they silently fail.
    if not (Exec('schtasks.exe', '/delete /tn "' + TaskName + '" /f', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0)) then
      SuppressibleMsgBox('Could not delete the scheduled task ' + TaskName + '. If it still exists, remove it manually from Task Scheduler.',
        mbError, MB_OK, IDOK);

    // FINDING B fix: netsh's "delete rule name=" matches DisplayName, not the
    // Name register-task.ps1 actually creates the rule with
    // (NecesseDaemon-Inbound), so it never matched anything and the port
    // stayed open forever after uninstall. Remove-NetFirewallRule matches by
    // Name.
    if not (Exec('powershell.exe', '-NoProfile -Command "Remove-NetFirewallRule -Name ' + TaskName + '-Inbound -ErrorAction SilentlyContinue"',
                 '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0)) then
      SuppressibleMsgBox('Could not remove the firewall rule ' + TaskName + '-Inbound. If it still exists, remove it manually from Windows Defender Firewall.',
        mbError, MB_OK, IDOK);
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    // Deliberately NOT deleted, and deliberately not offered as a checkbox.
    // mod-library\ is the only copy of every uploaded and hand-placed jar,
    // and uninstall is the screen people click through fastest.
    //
    // FINDING E fix: SuppressibleMsgBox instead of MsgBox, so a scripted
    // uninstall (Task 4 runs one) does not hang forever on a dialog nothing
    // is there to click.
    SuppressibleMsgBox('The daemon has been removed.' + #13#10#13#10 +
           'Your worlds are untouched. Any configuration and mod library you had are still at:' + #13#10 +
           StateDir() + #13#10#13#10 +
           'Delete that folder yourself if you want it gone - it holds the only copy of any mod jar you uploaded by hand.',
           mbInformation, MB_OK, IDOK);
  end;
end;
