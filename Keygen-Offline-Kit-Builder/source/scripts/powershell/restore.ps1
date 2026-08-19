<#
.SYNOPSIS
Restores Keygen Authoritative State.
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$BackupDir
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path $BackupDir)) { throw "Backup directory not found: $BackupDir" }

$EnvDir = "$env:SystemDrive\KeygenEnv"
Write-Host "WARNING: This will overwrite current installation state." -ForegroundColor Red
$confirm = Read-Host "Type 'RESTORE' to continue"
if ($confirm -cne "RESTORE") { Write-Host "Aborted."; exit 0 }

# Verify checksums
Write-Host "Verifying Backup Checksums..."
$checksumFile = "$BackupDir\checksums.sha256"
if (-not (Test-Path $checksumFile)) { throw "Checksums file missing." }
Get-Content $checksumFile | ForEach-Object {
    $parts = $_ -split "  "
    $expected = $parts[0]
    $file = "$BackupDir\$($parts[1])"
    if (-not (Test-Path $file)) { throw "Missing file: $file" }
    $actual = (Get-FileHash $file -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw "Corrupt file: $file" }
}
Write-Host "Backup is valid." -ForegroundColor Green

# 1. Stop all except postgres
Write-Host "Stopping Services..."
docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" stop web worker caddy redis

# 2. Restore DB
Write-Host "Dropping and recreating database..."
docker exec postgres dropdb -U keygen keygen
docker exec postgres createdb -U keygen keygen
if ($LASTEXITCODE -ne 0) { throw "Failed to recreate the Keygen database structure in Postgres." }

Write-Host "Restoring PostgreSQL dump..."
docker cp "$BackupDir\database.dump" postgres:/tmp/backup.dump
docker exec postgres pg_restore -U keygen -d keygen /tmp/backup.dump
if ($LASTEXITCODE -ne 0) { throw "pg_restore encountered errors. The database might be in an inconsistent state!" }
docker exec postgres rm /tmp/backup.dump

# 3. Restore Config
Write-Host "Restoring configuration..."
Copy-Item "$BackupDir\keygen.env" -Destination "$EnvDir\.env" -Force

# 4. Restore TLS
Write-Host "Restoring Caddy PKI..."
docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" up -d caddy
Start-Sleep -Seconds 2
docker cp "$BackupDir\tls\pki" caddy:/data/caddy/
docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" restart caddy

# 5. Start
Write-Host "Starting all services..."
docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" up -d web worker
Start-Sleep -Seconds 10
.\scripts\powershell\health.ps1
Write-Host "Restore completed." -ForegroundColor Green
