@echo off
cd /d "%~dp0..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\powershell\restart.ps1" %*
pause
