@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0SuperStickmanServer.exe" (
  echo [FEHLER] SuperStickmanServer.exe fehlt
  exit /b 1
)

start /wait "" "%~dp0SuperStickmanServer.exe" -server -logfile "%~dp0host_log.txt"
exit /b %ERRORLEVEL%
