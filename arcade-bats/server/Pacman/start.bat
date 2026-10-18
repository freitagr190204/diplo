@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0Pacman.exe" (
  echo [FEHLER] Pacman.exe fehlt
  exit /b 1
)

start /wait "" "%~dp0Pacman.exe" -host -logfile "%~dp0host_log.txt"
exit /b %ERRORLEVEL%
