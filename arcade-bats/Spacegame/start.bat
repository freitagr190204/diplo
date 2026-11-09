@echo off
setlocal
cd /d "%~dp0"
set HOST=192.168.10.1

if /I "%~1"=="client" (
  start /wait "" "%~dp0Spacegame.exe" -client -ip=%HOST% -logfile "%~dp0client_log.txt"
) else (
  start /wait "" "%~dp0Spacegame.exe" -host -logfile "%~dp0host_log.txt"
)
