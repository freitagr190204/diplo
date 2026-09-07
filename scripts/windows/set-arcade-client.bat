@echo off
setlocal
title Arcade Netzwerk - Client (192.168.10.2)

call "%~dp0_set-arcade-client.bat"
if %errorlevel% neq 0 (
  echo.
  pause
  exit /b 1
)

echo.
echo Server-PC muss zuerst 192.168.10.1 haben, dann GameLauncher auf beiden starten.
echo Vor der Schule restore-school-network.bat ausfuehren.
echo.
pause
