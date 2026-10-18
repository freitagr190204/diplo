@echo off
call "%~dp0_require-admin.bat" || exit /b 1
call "%~dp0arcade-network.config.bat"

echo.
echo Setze temporaere Arcade-IP auf Server-PC...
echo Adapter: %ARCADE_ADAPTER%
echo IP:      192.168.10.1
echo.

netsh interface ip set address name="%ARCADE_ADAPTER%" static 192.168.10.1 255.255.255.0
if %errorlevel% neq 0 (
  echo.
  echo [FEHLER] Konnte IP nicht setzen. Adapter-Name in arcade-network.config.bat pruefen.
  echo Verfuegbare Adapter:
  netsh interface show interface
  exit /b 1
)

echo Fertig. Dieser PC ist jetzt Server ^(192.168.10.1^).
exit /b 0
