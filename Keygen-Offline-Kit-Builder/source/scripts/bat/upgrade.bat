@echo off
cd /d "%~dp0..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\powershell\upgrade.ps1" %*
pause
