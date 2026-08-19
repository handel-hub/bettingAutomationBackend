<#
.SYNOPSIS
Backups the Keygen Authoritative State.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$EnvDir = "$env:SystemDrive\KeygenEnv"
if (-not (Test-Path "$EnvDir\.env")) { Write-Error "Deployment not configured."; exit 1 }

$BackupDate = Get-Date -Format "yyyy-MM-dd_HHmmss"
$BackupDir = "backups\$BackupDate"
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
New-Item -ItemType Directory -Path "$BackupDir\tls" -Force | Out-Null

Write-Host "Creating Backup $BackupDate..."

# 1. Stop app layer (drain workers/web to prevent partial transactions)
Write-Host "Stopping Web and Worker..."
docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" stop web worker
if ($LASTEXITCODE -ne 0) { throw "Failed to stop web and worker containers cleanly." }

# 2. Dump Postgres (Custom physical backup format)
Write-Host "Exporting PostgreSQL..."
$proc = Start-Process docker -ArgumentList "exec postgres pg_dump -Fc -U keygen -d keygen -f /tmp/backup.dump" -WindowStyle Hidden -PassThru
$sec = 0
while (-not $proc.HasExited) {
    $sec++
    Write-Progress -Activity "Keygen Backup" -Status "Dumping PostgreSQL Database... ($sec seconds elapsed)"
    Start-Sleep -Seconds 1
}
Write-Progress -Activity "Keygen Backup" -Completed
if ($proc.ExitCode -ne 0) { throw "PostgreSQL database dump failed! Aborting backup." }
docker cp postgres:/tmp/backup.dump "$BackupDir\database.dump"
docker exec postgres rm /tmp/backup.dump

# 3. Copy Secrets/Config
Write-Host "Backing up configuration..."
Copy-Item "$EnvDir\.env" -Destination "$BackupDir\keygen.env"

# 4. Copy TLS State
Write-Host "Backing up Caddy PKI..."
docker cp caddy:/data/caddy/pki "$BackupDir\tls\pki"

# 5. Manifest
Write-Host "Creating Backup Manifest..."
Copy-Item ".\manifest.json" -Destination "$BackupDir\manifest.json"

# 6. Checksums
Write-Host "Hashing backup artifacts..."
Get-ChildItem -Path $BackupDir -Recurse -File | Where-Object { $_.Name -ne "checksums.sha256" } | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    $relativePath = $_.FullName.Replace((Resolve-Path $BackupDir).Path + "\", "").Replace("\", "/")
    "$hash  $relativePath" | Out-File -Append -Encoding ascii "$BackupDir\checksums.sha256"
}

Write-Host "Restarting Web and Worker..."
docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" start web worker

Write-Host "Backup completed at $BackupDir" -ForegroundColor Green
