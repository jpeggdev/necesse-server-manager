@echo off
setlocal
cd /d "%~dp0"
rem The installer ships a private Node beside these shims; the release zip does
rem not and uses whatever is on PATH. One set of shims serves both artifacts,
rem because two sets would drift.
set "NODE=node"
if exist "%~dp0node\node.exe" set "NODE=%~dp0node\node.exe"
"%NODE%" dist\migrate-cli.js %*
endlocal
