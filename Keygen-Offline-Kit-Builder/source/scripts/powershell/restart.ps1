<#
.SYNOPSIS
Restarts the Keygen services.
#>
$EnvDir = "$env:SystemDrive\KeygenEnv"
if (-not (Test-Path "$EnvDir\.env")) { Write-Error "Deployment not configured."; exit 1 }

Write-Host "Restarting Keygen Services..."
docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" restart
Write-Host "Services restarted." -ForegroundColor Green
