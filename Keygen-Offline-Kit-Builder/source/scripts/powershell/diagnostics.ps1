<#
.SYNOPSIS
Collects diagnostics.
#>
$EnvDir = "$env:SystemDrive\KeygenEnv"
$Date = Get-Date -Format "yyyyMMdd-HHmmss"
$DiagDir = "diagnostics-$Date"
New-Item -ItemType Directory -Path $DiagDir | Out-Null

Write-Host "Collecting diagnostics..."

# Windows & WSL
systeminfo > "$DiagDir\systeminfo.txt"
wsl --status > "$DiagDir\wsl-status.txt"

# Docker
docker info > "$DiagDir\docker-info.txt"
docker compose version > "$DiagDir\docker-compose-version.txt"

# Containers
if (Test-Path "$EnvDir\.env") {
    docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" ps > "$DiagDir\containers-ps.txt"
    docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" logs --tail 200 > "$DiagDir\containers-logs.txt"
}

Compress-Archive -Path $DiagDir -DestinationPath "$DiagDir.zip"
Remove-Item -Recurse -Force $DiagDir

Write-Host "Diagnostics saved to $DiagDir.zip" -ForegroundColor Green
