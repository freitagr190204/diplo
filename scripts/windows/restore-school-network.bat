@echo off
setlocal EnableExtensions
title Schule-Netzwerk wiederherstellen (DHCP)

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo Admin-Rechte werden angefordert - bitte auf "Ja" klicken...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

call "%~dp0arcade-network.config.bat"

echo.
echo Stelle automatische IP-Konfiguration wieder her...
echo Adapter: %ARCADE_ADAPTER%
echo.

netsh interface ip set address name="%ARCADE_ADAPTER%" dhcp
netsh interface ip set dns name="%ARCADE_ADAPTER%" dhcp
if %errorlevel% neq 0 (
  echo.
  echo [FEHLER] Konnte DHCP nicht aktivieren.
  netsh interface show interface
  goto :failed
)

echo.
echo Fertig. Dieser PC holt die IP wieder automatisch vom Schulnetz.
echo.
pause
exit /b 0

:failed
echo.
pause
exit /b 1
