<#
.SYNOPSIS
Displays the status of Keygen services.
#>
$EnvDir = "$env:SystemDrive\KeygenEnv"
if (-not (Test-Path "$EnvDir\.env")) { Write-Error "Deployment not configured."; exit 1 }

docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" ps
