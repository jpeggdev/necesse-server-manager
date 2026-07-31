@echo off
setlocal
cd /d "%~dp0"
rem Elevating wrapper around register-task.ps1, and the target of the Start Menu
rem "Register boot task" shortcut.
rem
rem That shortcut used to point straight at powershell.exe -File on the .ps1,
rem which runs with whatever token the shell hands it - not an elevated one.
rem Register-ScheduledTask with a SYSTEM ServiceAccount principal then throws
rem access-denied, New-NetFirewallRule fails silently because it carries
rem -ErrorAction SilentlyContinue, and the console closes before either can be
rem read. So: elevate first, and pause at the end so the output survives.
rem
rem The elevation test is done by PowerShell rather than "net session", which
rem depends on the Server service and would report "not elevated" on a machine
rem where that service is off - and an elevated relaunch that still failed the
rem test would prompt forever. --elevated is the second belt on that: it marks
rem the relaunched copy so a declined prompt ends in a message, not a loop.
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto :run

if /i "%~1"=="--elevated" (
  echo Still not running as Administrator: the elevation prompt was declined,
  echo or this account cannot elevate. Nothing has been changed.
  echo.
  pause
  goto :eof
)

echo Administrator rights are required to register the boot task.
echo Asking Windows for them now - accept the prompt.
rem Passed through the environment rather than interpolated into the -Command
rem string: %~dp0 can contain spaces, and $env:NSM_SELF needs no quoting of its
rem own once PowerShell has it.
set "NSM_SELF=%~dp0register-task.cmd"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:NSM_SELF -ArgumentList '--elevated' -Verb RunAs"
goto :eof

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-task.ps1"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo register-task.ps1 exited with code %RC%.
pause
endlocal & exit /b %RC%
