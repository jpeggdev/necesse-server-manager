@echo off
setlocal
cd /d "%~dp0"
node dist\migrate-cli.js %*
endlocal
