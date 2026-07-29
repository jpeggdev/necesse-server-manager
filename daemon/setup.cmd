@echo off
setlocal
cd /d "%~dp0"
node dist\setup-cli.js %*
endlocal
