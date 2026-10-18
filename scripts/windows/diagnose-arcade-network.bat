@echo off
setlocal EnableExtensions
title Arcade Diagnose

echo.
echo === Arcade Netzwerk Diagnose ===
echo.

call "%~dp0arcade-network.config.bat"

echo [1] Administrator?
net session >nul 2>&1
if %errorlevel% equ 0 (
  echo     JA
) else (
  echo     NEIN  ^(Scripts brauchen Admin / Rechtsklick^)
)

echo.
echo [2] Konfiguration
echo     Adapter:       %ARCADE_ADAPTER%
echo     GameLauncher:  %GAME_LAUNCHER%

echo.
echo [3] Launcher vorhanden?
if exist "%GAME_LAUNCHER%" (
  echo     JA - %GAME_LAUNCHER%
) else (
  echo     NEIN - Pfad in arcade-network.config.bat anpassen!
)

echo.
echo [4] Netzwerk-Adapter auf diesem PC
netsh interface show interface

echo.
echo [5] Aktuelle IPv4-Adressen
powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object { $_.IPAddress -notlike '127.*' } ^| Format-Table InterfaceAlias, IPAddress -AutoSize"

echo.
echo [6] Test netsh auf konfiguriertem Adapter
netsh interface ip show config name="%ARCADE_ADAPTER%" 2>nul
if %errorlevel% neq 0 (
  echo     FEHLER: Adapter "%ARCADE_ADAPTER%" nicht gefunden!
  echo     Richtigen Namen in arcade-network.config.bat eintragen.
)

echo.
pause
