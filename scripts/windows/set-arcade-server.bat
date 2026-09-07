@echo off
setlocal
title Arcade Netzwerk - Server (192.168.10.1)

call "%~dp0_set-arcade-server.bat"
if %errorlevel% neq 0 (
  echo.
  pause
  exit /b 1
)

echo.
echo Danach Client-PC mit set-arcade-client.bat einrichten und GameLauncher starten.
echo Vor der Schule restore-school-network.bat ausfuehren.
echo.
pause
