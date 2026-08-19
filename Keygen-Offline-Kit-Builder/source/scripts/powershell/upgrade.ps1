<#
.SYNOPSIS
Upgrades Keygen to a new kit version.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "Starting Upgrade Process..."
Write-Host "Did you run backup.bat from the OLD kit first?" -ForegroundColor Yellow
$confirm = Read-Host "Type 'YES' to continue"
if ($confirm -cne "YES") { Write-Host "Aborted. Please backup first."; exit 0 }

$EnvDir = "$env:SystemDrive\KeygenEnv"
if (-not (Test-Path "$EnvDir\.env")) { throw "Configuration missing. Cannot upgrade." }

# 1. Load new images
Write-Host "Loading new images..."
docker load -i "images\keygen-images.tar.gz"

# 2. Update .env image tags
Write-Host "Updating environment configuration..."
$manifest = Get-Content "manifest.json" -Raw | ConvertFrom-Json
$envVars = Get-Content "$EnvDir\.env" -Raw
$envVars = $envVars -replace 'IMAGE_KEYGEN=".*"', "IMAGE_KEYGEN=`"keygen/api:v1.7.2@$($manifest.images.keygen.digest)`""
$envVars = $envVars -replace 'IMAGE_POSTGRES=".*"', "IMAGE_POSTGRES=`"postgres:17.5@$($manifest.images.postgres.digest)`""
$envVars = $envVars -replace 'IMAGE_REDIS=".*"', "IMAGE_REDIS=`"redis:7.2-alpine@$($manifest.images.redis.digest)`""
$envVars = $envVars -replace 'IMAGE_CADDY=".*"', "IMAGE_CADDY=`"caddy:2.7-alpine@$($manifest.images.caddy.digest)`""
Set-Content -Path "$EnvDir\.env" -Value $envVars

# 3. Recreate containers
Write-Host "Recreating containers with new images..."
docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" up -d postgres redis
Start-Sleep -Seconds 5

# 4. Run Migrations
Write-Host "Running Database Migrations..."
docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" run --rm migrate
if ($LASTEXITCODE -ne 0) { throw "Migrations failed! Check logs and consider rollback." }

# 5. Start App
Write-Host "Starting upgraded services..."
docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" up -d web worker caddy

.\scripts\powershell\health.ps1
Write-Host "Upgrade completed successfully." -ForegroundColor Green
