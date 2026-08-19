<#
.SYNOPSIS
Builds the Keygen Offline Deployment Kit. Must be run on an internet-connected machine.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Enforce modern TLS for web requests (fixes connection resets on some machines)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not (Test-Path "installers")) { New-Item -ItemType Directory -Path "installers" | Out-Null }

function Download-FileWithRetry {
    param([string]$Url, [string]$OutFile)
    
    $fileName = Split-Path $OutFile -Leaf
    $localPath = "installers\$fileName"
    
    if (Test-Path $localPath) {
        Write-Host "Found $fileName in local 'installers' folder. Skipping download!" -ForegroundColor Green
        Copy-Item $localPath -Destination $OutFile -Force
        return
    }

    $maxAttempts = 3
    for ($i = 1; $i -le $maxAttempts; $i++) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $OutFile -ErrorAction Stop
            # Save to local installers folder for next time
            Copy-Item $OutFile -Destination $localPath -Force
            return
        } catch {
            Write-Host "Download failed ($i/$maxAttempts): $_" -ForegroundColor Red
            if ($i -lt $maxAttempts) {
                Write-Host "Retrying in 5 seconds..." -ForegroundColor Yellow
                Start-Sleep -Seconds 5
            } else {
                throw "Failed to download $Url. If 'desktop.docker.com' is blocked, manually download $fileName and place it in the 'installers' folder next to this script."
            }
        }
    }
}

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
    $dockerCmd = Get-Command "docker" -ErrorAction SilentlyContinue
    
    if (-not $dockerCmd -and -not (Test-Path "C:\Program Files\Docker\Docker\Docker Desktop.exe")) {
        Write-Host "Docker Desktop is not installed. Downloading and installing automatically..." -ForegroundColor Yellow
        $tempInstaller = "$env:TEMP\Docker-Desktop-Installer.exe"
        Download-FileWithRetry -Url $Installers["DockerDesktop"] -OutFile $tempInstaller
        
        Write-Host "Running Docker Desktop Installer... (Please approve any UAC prompts)" -ForegroundColor Yellow
        Write-Host "Installing" -NoNewline
        $proc = Start-Process $tempInstaller -ArgumentList 'install --quiet --accept-license' -PassThru
        while (-not $proc.HasExited) {
            Write-Host "." -NoNewline -ForegroundColor Cyan
            Start-Sleep -Seconds 2
        }
        Write-Host " Done!" -ForegroundColor Green
        
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
Download-FileWithRetry -Url $Installers["DockerDesktop"] -OutFile "$OutputName/installers/Docker-Desktop-Installer.exe"
Write-Host "Downloading WSL2 Kernel Update..."
Download-FileWithRetry -Url $Installers["WslUpdate"] -OutFile "$OutputName/installers/wsl_update_x64.msi"

# 4. Pull Images & Resolve Digests
$Digests = @{}
foreach ($key in $Images.Keys) {
    $imageTag = $Images[$key]
    Write-Host "Pulling $imageTag (linux/amd64)..." -ForegroundColor Yellow
    docker pull $imageTag --platform linux/amd64
    if ($LASTEXITCODE -ne 0) { throw "Failed to pull image $imageTag. Check your internet connection." }
    
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
$exportCmd = "cmd.exe /c `"docker save $imageRefs | gzip > $OutputName/images/keygen-images.tar.gz`""
$proc = Start-Process powershell -ArgumentList "-NoProfile -Command `"$exportCmd`"" -WindowStyle Hidden -PassThru
$sec = 0
while (-not $proc.HasExited) {
    $sec++
    Write-Progress -Activity "Packaging Kit" -Status "Compressing Docker Images... ($sec seconds elapsed)"
    Start-Sleep -Seconds 1
}
Write-Progress -Activity "Packaging Kit" -Completed
if ($proc.ExitCode -ne 0) { throw "Failed to export images to archive. Ensure you have enough disk space." }

# 6. Hash the Image Archive
Write-Host "Hashing archive..." -ForegroundColor Yellow
$hashJob = Start-Job -ScriptBlock { (Get-FileHash $args[0] -Algorithm SHA256).Hash } -ArgumentList "$OutputName/images/keygen-images.tar.gz"
$sec = 0
while ($hashJob.State -eq 'Running') {
    $sec++
    Write-Progress -Activity "Packaging Kit" -Status "Calculating Checksums... ($sec seconds elapsed)"
    Start-Sleep -Seconds 1
}
Write-Progress -Activity "Packaging Kit" -Completed
$archiveHash = Receive-Job $hashJob
Remove-Job $hashJob

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
