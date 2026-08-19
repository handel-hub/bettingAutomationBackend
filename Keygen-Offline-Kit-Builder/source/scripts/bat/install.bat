@echo off
cd /d "%~dp0..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\powershell\install.ps1" %*
pause
