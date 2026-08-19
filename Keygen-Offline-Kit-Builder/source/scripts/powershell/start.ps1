<#
.SYNOPSIS
Starts the Keygen services.
#>
$EnvDir = "$env:SystemDrive\KeygenEnv"
if (-not (Test-Path "$EnvDir\.env")) { Write-Error "Deployment not configured. Run install.bat first."; exit 1 }

Write-Host "Starting Keygen Services..."
docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" up -d
Write-Host "Services started." -ForegroundColor Green
