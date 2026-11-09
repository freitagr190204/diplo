@echo off
cd /d "%~dp0"
start /wait "" "%~dp0Spacegame.exe" -client -ip=192.168.10.1 -logfile "%~dp0client_log.txt"
