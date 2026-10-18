@echo off
setlocal EnableExtensions

if /I not "%~1"=="elevated" (
  call "%~dp0_elevate-if-needed.bat"
  exit /b 1
)

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo [FEHLER] Keine Administrator-Rechte.
  echo Rechtsklick auf die Datei -^> "Als Administrator ausfuehren"
  echo.
  pause
  exit /b 1
)

exit /b 0
