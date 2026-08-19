@echo off
cd /d "%~dp0..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\powershell\stop.ps1" %*
pause
