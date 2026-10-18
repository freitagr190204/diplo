@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0Spacegame.exe" (
  echo [FEHLER] Spacegame.exe fehlt
  exit /b 1
)

start /wait "" "%~dp0Spacegame.exe" -host -logfile "%~dp0host_log.txt"
exit /b %ERRORLEVEL%
