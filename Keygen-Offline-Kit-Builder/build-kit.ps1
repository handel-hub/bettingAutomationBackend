<#
.SYNOPSIS
Builds the Keygen Offline Deployment Kit. Must be run on an internet-connected machine.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$KitVersion = "1.0.0"
$OutputName = "Keygen-Offline-Kit-v$KitVersion"

$Images = @{
    "keygen"   = "keygen/api:v1.7.2"
    "postgres" = "postgres:17.5"
    "redis"    = "redis:7.2-alpine"
    "caddy"    = "caddy:2.7-alpine"
}

$Installers = @{
    "DockerDesktop" = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
    "WslUpdate"     = "https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi"
}

Write-Host "Starting Online Kit Builder for v$KitVersion" -ForegroundColor Cyan

# 1. Verify Docker is available locally to pull/export images
function Verify-DockerReady {
    for ($i = 1; $i -le 30; $i++) {
        try {
            $info = docker info 2>&1
            if ($LASTEXITCODE -eq 0) { return $true }
        } catch {}
        Start-Sleep -Seconds 2
    }
    return $false
}

Write-Host "Checking if Docker is running..."
if (-not (Verify-DockerReady)) {
    Write-Host "Docker daemon is not responding. Checking if Docker Desktop is installed..." -ForegroundColor Yellow
    $dockerPath = (Get-Command "docker" -ErrorAction SilentlyContinue).Source
    
    if (-not $dockerPath -and -not (Test-Path "C:\Program Files\Docker\Docker\Docker Desktop.exe")) {
        Write-Host "Docker Desktop is not installed. Downloading and installing automatically..." -ForegroundColor Yellow
        $tempInstaller = "$env:TEMP\Docker-Desktop-Installer-Temp.exe"
        Invoke-WebRequest -Uri $Installers["DockerDesktop"] -OutFile $tempInstaller
        
        Write-Host "Running Docker Desktop Installer... (Please approve any UAC prompts)" -ForegroundColor Yellow
        Start-Process $tempInstaller -Wait -ArgumentList 'install --quiet --accept-license'
        
        $env:Path += ";C:\Program Files\Docker\Docker\resources\bin"
    }
    
    if (Test-Path "C:\Program Files\Docker\Docker\Docker Desktop.exe") {
        Write-Host "Attempting to start Docker Desktop..." -ForegroundColor Yellow
        Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    }
    
    Write-Host "Waiting for Docker to start up (this may take a minute)..."
    if (-not (Verify-DockerReady)) {
        Write-Error "Docker failed to start. If you just installed it, you may need to REBOOT your computer first to enable WSL features, then run this script again."
        exit 1
    }
}
Write-Host "Docker is ready!" -ForegroundColor Green

# 2. Prepare Directory
if (Test-Path $OutputName) { Remove-Item -Recurse -Force $OutputName }
New-Item -ItemType Directory -Path $OutputName | Out-Null
New-Item -ItemType Directory -Path "$OutputName/installers" | Out-Null
New-Item -ItemType Directory -Path "$OutputName/images" | Out-Null
Copy-Item -Recurse -Path "source/*" -Destination $OutputName

# 3. Download Installers
Write-Host "Downloading Docker Desktop Installer..."
Invoke-WebRequest -Uri $Installers["DockerDesktop"] -OutFile "$OutputName/installers/Docker-Desktop-Installer.exe"
Write-Host "Downloading WSL2 Kernel Update..."
Invoke-WebRequest -Uri $Installers["WslUpdate"] -OutFile "$OutputName/installers/wsl_update_x64.msi"

# 4. Pull Images & Resolve Digests
$Digests = @{}
foreach ($key in $Images.Keys) {
    $imageTag = $Images[$key]
    Write-Host "Pulling $imageTag (linux/amd64)..." -ForegroundColor Yellow
    docker pull $imageTag --platform linux/amd64 | Out-Null
    
    $inspect = docker image inspect $imageTag | ConvertFrom-Json
    $digest = $inspect[0].RepoDigests | Where-Object { $_ -match "@sha256:" } | Select-Object -First 1
    
    if (-not $digest) {
        Write-Error "Failed to resolve RepoDigest for $imageTag. This image may not have been pulled from a registry."
        exit 1
    }
    
    $Digests[$key] = $digest
    Write-Host "Resolved $key -> $digest" -ForegroundColor Green
}

# 5. Export Images
Write-Host "Exporting images to archive..." -ForegroundColor Yellow
$imageRefs = $Images.Values -join " "
Invoke-Expression "docker save $imageRefs | gzip > $OutputName/images/keygen-images.tar.gz"

# 6. Hash the Image Archive
Write-Host "Hashing archive..."
$archiveHash = (Get-FileHash "$OutputName/images/keygen-images.tar.gz" -Algorithm SHA256).Hash

# 7. Generate Manifest
Write-Host "Generating manifest.json..."
$manifestTemplate = Get-Content "manifest.json.template" -Raw
$manifestJson = $manifestTemplate `
    -replace "{{KIT_VERSION}}", $KitVersion `
    -replace "{{BUILD_DATE}}", (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ") `
    -replace "{{KEYGEN_IMAGE}}", $Digests["keygen"] `
    -replace "{{POSTGRES_IMAGE}}", $Digests["postgres"] `
    -replace "{{REDIS_IMAGE}}", $Digests["redis"] `
    -replace "{{CADDY_IMAGE}}", $Digests["caddy"] `
    -replace "{{ARCHIVE_SHA256}}", $archiveHash

Set-Content -Path "$OutputName/manifest.json" -Value $manifestJson

# 8. Checksum the Kit Core
Write-Host "Generating kit checksums..."
Get-ChildItem -Path "$OutputName/scripts", "$OutputName/config" -Recurse -File | ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    $relativePath = $_.FullName.Replace((Resolve-Path $OutputName).Path + "\", "").Replace("\", "/")
    "$hash  $relativePath" | Out-File -Append -Encoding ascii "$OutputName/checksums.sha256"
}

Write-Host "Packaging complete: $OutputName" -ForegroundColor Cyan
Write-Host "You may now zip the '$OutputName' directory and transfer it to the offline machine." -ForegroundColor Green
