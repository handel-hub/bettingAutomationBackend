@echo off
cd /d "%~dp0..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\powershell\status.ps1" %*
pause
