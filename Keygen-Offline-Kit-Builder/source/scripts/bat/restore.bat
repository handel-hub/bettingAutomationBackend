@echo off
cd /d "%~dp0..\.."
if "%~1"=="" ( echo Usage: restore.bat ^<path_to_backup_dir^> & pause & exit /b 1 )
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\powershell\restore.ps1" -BackupDir "%~1"
pause
