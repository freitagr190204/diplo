@echo off
setlocal EnableExtensions
title Arcade starten - Client

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo Admin-Rechte werden angefordert - bitte auf "Ja" klicken...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

call "%~dp0arcade-network.config.bat"
call "%~dp0_set-arcade-client.bat"
if %errorlevel% neq 0 goto :failed

echo.
echo Starte GameLauncher...

if not exist "%GAME_LAUNCHER%" (
  echo.
  echo [FEHLER] GameLauncher nicht gefunden:
  echo   %GAME_LAUNCHER%
  echo.
  echo Bitte Pfad in arcade-network.config.bat setzen.
  echo Tipp: diagnose-arcade-network.bat ausfuehren.
  goto :failed
)

start "" "%GAME_LAUNCHER%"
echo Launcher gestartet.
echo.
echo Client laeuft auf 192.168.10.2
echo Im Launcher Messemodus waehlen und auf "Verbunden" warten.
echo.
pause
exit /b 0

:failed
echo.
pause
exit /b 1
