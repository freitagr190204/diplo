@echo off
cd /d "%~dp0"
start /wait "" "%~dp0Spacegame.exe" -host -logfile "%~dp0host_log.txt"
