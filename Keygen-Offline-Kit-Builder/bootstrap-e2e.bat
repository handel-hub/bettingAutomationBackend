@echo off
:: Requests Administrator Privileges automatically if not running as admin
net session >nul 2>&1
if %errorLevel% == 0 (
    goto :RunScript
) else (
    echo Requesting Administrator privileges...
    powershell -Command "Start-Process '%~dpnx0' -Verb RunAs"
    exit /b
)

:RunScript
cd /d "%~dp0"
echo Starting End-to-End Bootstrap...
powershell -NoProfile -ExecutionPolicy Bypass -File "bootstrap-e2e.ps1"
pause
