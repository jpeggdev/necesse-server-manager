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
; Created so the Start Menu "Open state folder" shortcut is valid before the
; daemon has ever run. An empty directory here is safe: the legacy-state check
; treats a state directory as populated only when it actually contains
; something, so this cannot make a pre-migration install look migrated.
Name: "{commonappdata}\NecesseServerManager"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

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

// Stopping is not optional on an upgrade: node.exe cannot be overwritten while
// it is running, and a surviving process keeps the port, so the daemon that
// starts afterwards would die on EADDRINUSE while the old one kept answering.
procedure StopDaemonTask();
var
  Code: Integer;
begin
  if not ScheduledTaskExists() then Exit;
  Exec('schtasks.exe', '/end /tn "' + TaskName + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(3000);
end;

// The boot-task checkbox defaults to what the machine already has, not to a
// blanket yes. Someone who deliberately runs the daemon by hand should not
// acquire a boot task because they accepted a default on an upgrade screen.
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
  RanSetup: Boolean;
begin
  if CurStep = ssInstall then
  begin
    StopDaemonTask();
  end
  else if CurStep = ssPostInstall then
  begin
    RanSetup := False;
    if WizardIsTaskSelected('runsetup') and (not ConfigExists()) then
    begin
      // Visible and waited on: the wizard is interactive and cannot be
      // scripted, so there is nothing to do but show it and let the operator
      // answer. Running it hidden would hang forever on the first prompt.
      Exec(ExpandConstant('{app}\setup.cmd'), '', ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, Code);
      RanSetup := True;
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
          MsgBox('The daemon was installed, but registering the boot task did not complete.' + #13#10#13#10 +
                 'You can retry it from the Start Menu (Register boot task). If the daemon refuses to start, it writes the reason to:' + #13#10 +
                 StateDir() + '\boot-refusal.txt',
                 mbError, MB_OK);
      end
      else if RanSetup then
        MsgBox('Setup did not finish, so no configuration was written and the boot task was not registered.' + #13#10#13#10 +
               'Run "Setup" from the Start Menu when you are ready, then "Register boot task".',
               mbInformation, MB_OK);
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Exec('schtasks.exe', '/end /tn "' + TaskName + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(2000);
    Exec('schtasks.exe', '/delete /tn "' + TaskName + '" /f', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Exec('netsh.exe', 'advfirewall firewall delete rule name="' + TaskName + '-Inbound"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    // Deliberately NOT deleted, and deliberately not offered as a checkbox.
    // mod-library\ is the only copy of every uploaded and hand-placed jar, and
    // uninstall is the screen people click through fastest.
    MsgBox('The daemon has been removed.' + #13#10#13#10 +
           'Your worlds are untouched, and your configuration and mod library were left in place at:' + #13#10 +
           StateDir() + #13#10#13#10 +
           'Delete that folder yourself if you want it gone. It holds the only copy of any mod jar you uploaded by hand.',
           mbInformation, MB_OK);
  end;
end;
