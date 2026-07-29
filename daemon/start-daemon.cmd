@echo off
setlocal
cd /d "%~dp0"
node dist\index.js %*
endlocal
