@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0Spacegame.exe" (
  echo [FEHLER] Spacegame.exe fehlt
  exit /b 1
)

start /wait "" "%~dp0Spacegame.exe" -client -ip=192.168.10.1 -logfile "%~dp0client_log.txt"
exit /b %ERRORLEVEL%
