<#
.SYNOPSIS
Main installation orchestrator for the Keygen Offline Deployment Kit.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$StateFile = "$env:SystemDrive\KeygenEnv\install-state.json"
$EnvDir = "$env:SystemDrive\KeygenEnv"
$ManifestPath = ".\manifest.json"

function Get-InstallState {
    if (Test-Path $StateFile) {
        return (Get-Content $StateFile -Raw) | ConvertFrom-Json
    }
    return @{ State = "PREFLIGHT" }
}

function Set-InstallState {
    param([string]$State)
    if (-not (Test-Path $EnvDir)) { New-Item -ItemType Directory -Path $EnvDir | Out-Null }
    @{ State = $State } | ConvertTo-Json | Set-Content -Path $StateFile
    Write-Host ">>> State advanced to: $State" -ForegroundColor Green
}

function Run-Preflight {
    Write-Host "Running Pre-Flight Checks..."
    $fail = $false

    # Admin check
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) { Write-Host "[FAIL] Script must be run as Administrator." -ForegroundColor Red; $fail = $true } else { Write-Host "[PASS] Administrator Privileges" -ForegroundColor Green }

    # Architecture check
    if (-not [System.Environment]::Is64BitOperatingSystem) { Write-Host "[FAIL] 64-bit OS required." -ForegroundColor Red; $fail = $true } else { Write-Host "[PASS] 64-bit OS" -ForegroundColor Green }

    # RAM Check
    $mem = Get-CimInstance Win32_OperatingSystem
    $totalRamGB = [math]::Round($mem.TotalVisibleMemorySize / 1MB, 2)
    if ($totalRamGB -lt 4) { Write-Host "[FAIL] Minimum 4GB RAM required. Detected $totalRamGB GB." -ForegroundColor Red; $fail = $true }
    elseif ($totalRamGB -lt 8) { Write-Host "[WARN] Memory is constrained ($totalRamGB GB). Recommend 8GB+." -ForegroundColor Yellow }
    else { Write-Host "[PASS] RAM: $totalRamGB GB" -ForegroundColor Green }

    # Virtualization
    $hv = Get-CimInstance Win32_ComputerSystem
    if (-not $hv.HypervisorPresent) {
        Write-Host "[FAIL] Hardware Virtualization is disabled in BIOS or Hypervisor is not present." -ForegroundColor Red
        $fail = $true
    } else { Write-Host "[PASS] Hardware Virtualization Enabled" -ForegroundColor Green }

    if ($fail) { throw "Pre-flight checks failed. Cannot proceed." }
}

function Install-WindowsFeatures {
    Write-Host "Enabling Windows Features for WSL..."
    dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
    dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
}

function Install-WslKernel {
    Write-Host "Installing WSL2 Kernel..."
    Write-Host "Installing" -NoNewline
    $proc = Start-Process msiexec.exe -ArgumentList '/i "installers\wsl_update_x64.msi" /quiet /norestart' -PassThru
    while (-not $proc.HasExited) {
        Write-Host "." -NoNewline -ForegroundColor Cyan
        Start-Sleep -Seconds 2
    }
    Write-Host " Done!" -ForegroundColor Green
}

function Install-Docker {
    Write-Host "Installing Docker Desktop..."
    $dockerCmd = Get-Command "docker" -ErrorAction SilentlyContinue
    if ($dockerCmd) {
        Write-Host "Docker is already installed at $($dockerCmd.Source). Skipping." -ForegroundColor Yellow
        return
    }
    Write-Host "Installing" -NoNewline
    $proc = Start-Process "installers\Docker-Desktop-Installer.exe" -ArgumentList 'install --quiet --accept-license' -PassThru
    while (-not $proc.HasExited) {
        Write-Host "." -NoNewline -ForegroundColor Cyan
        Start-Sleep -Seconds 2
    }
    Write-Host " Done!" -ForegroundColor Green
}

function Verify-DockerReady {
    Write-Host "Waiting for Docker daemon to become ready..."
    $maxAttempts = 60
    for ($i = 1; $i -le $maxAttempts; $i++) {
        try {
            $info = docker info 2>&1
            if ($LASTEXITCODE -eq 0) { Write-Host "Docker is ready!" -ForegroundColor Green; return }
        } catch {}
        Start-Sleep -Seconds 2
    }
    throw "Docker failed to start within the expected time. Ensure Docker Desktop is running."
}

function Import-Images {
    Write-Host "Importing Docker Images..."
    $manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
    $expectedHash = $manifest.artifacts.archive_sha256
    $actualHash = (Get-FileHash "images\keygen-images.tar.gz" -Algorithm SHA256).Hash
    
    if ($expectedHash -ne $actualHash) { throw "Corrupt image archive! Expected $expectedHash, got $actualHash" }
    
    Write-Host "Hashes match. Loading images into Docker (This may take 1-2 minutes)..." -ForegroundColor Yellow
    docker load -i "images\keygen-images.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw "Failed to load Docker images into the daemon." }
}

function Generate-Config {
    Write-Host "Generating Configuration..."
    if (Test-Path "$EnvDir\.env") {
        Write-Host "Existing .env found. Skipping secret generation." -ForegroundColor Yellow
        return
    }

    $template = Get-Content "config\.env.template" -Raw
    $manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json

    $template = $template.Replace("{{IMAGE_KEYGEN}}", "keygen/api:v1.7.2@$($manifest.images.keygen.digest)")
    $template = $template.Replace("{{IMAGE_POSTGRES}}", "postgres:17.5@$($manifest.images.postgres.digest)")
    $template = $template.Replace("{{IMAGE_REDIS}}", "redis:7.2-alpine@$($manifest.images.redis.digest)")
    $template = $template.Replace("{{IMAGE_CADDY}}", "caddy:2.7-alpine@$($manifest.images.caddy.digest)")

    # Generate Secrets
    $genSecretBase64 = { [Convert]::ToBase64String((New-Guid).ToByteArray() + (New-Guid).ToByteArray()) }
    $genSecretHex = { ((New-Guid).ToByteArray() + (New-Guid).ToByteArray() | ForEach-Object { $_.ToString("x2") }) -join "" }
    $genId = { (New-Guid).ToString().ToLower() }

    $hostname = Read-Host "Enter the internal hostname for Keygen (e.g., license.internal.local)"
    if (-not $hostname) { $hostname = "license.internal.local" }

    $template = $template.Replace("{{KEYGEN_HOST}}", $hostname)
    $template = $template.Replace("{{POSTGRES_PASSWORD}}", (&$genSecretHex).Substring(0, 24))
    $template = $template.Replace("{{SECRET_KEY_BASE}}", (&$genSecretHex) + (&$genSecretHex))
    $template = $template.Replace("{{ENCRYPTION_DETERMINISTIC_KEY}}", &$genSecretBase64)
    $template = $template.Replace("{{ENCRYPTION_PRIMARY_KEY}}", &$genSecretBase64)
    $template = $template.Replace("{{ENCRYPTION_KEY_DERIVATION_SALT}}", &$genSecretBase64)
    $template = $template.Replace("{{KEYGEN_ACCOUNT_ID}}", &$genId)
    $template = $template.Replace("{{KEYGEN_ADMIN_EMAIL}}", "admin@$hostname")
    
    $adminPassword = (&$genSecretHex).Substring(0, 24)
    $template = $template.Replace("{{KEYGEN_ADMIN_PASSWORD}}", $adminPassword)

    Set-Content -Path "$EnvDir\.env" -Value $template
    
    # Restrict ACLs
    $acl = Get-Acl "$EnvDir\.env"
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators", "FullControl", "Allow")
    $acl.AddAccessRule($rule)
    Set-Acl -Path "$EnvDir\.env" -AclObject $acl

    Write-Host "Generated new .env configuration at $EnvDir\.env" -ForegroundColor Green
    Write-Host "=========================================" -ForegroundColor Cyan
    Write-Host "ADMIN EMAIL: admin@$hostname"
    Write-Host "ADMIN PASSWORD: $adminPassword"
    Write-Host "=========================================" -ForegroundColor Cyan
    Write-Host "SAVE THIS PASSWORD. IT WILL NOT BE SHOWN AGAIN." -ForegroundColor Red
}

function Init-Database {
    Write-Host "Initializing Keygen Database..."
    # Ensure Caddy config is copied
    if (-not (Test-Path "$EnvDir\Caddyfile")) { Copy-Item "config\Caddyfile" -Destination "$EnvDir\Caddyfile" }
    
    # Start dependencies
    docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" up -d postgres redis
    if ($LASTEXITCODE -ne 0) { throw "Failed to start database dependencies." }
    Start-Sleep -Seconds 5
    
    # Wait for Postgres
    Write-Host "Running Keygen Database Migrations and Setup (This may take up to a minute)..." -ForegroundColor Yellow
    docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" run --rm setup
    if ($LASTEXITCODE -ne 0) { throw "Keygen setup failed." }
}

function Start-Services {
    Write-Host "Starting all services..."
    docker compose --env-file "$EnvDir\.env" -f "config\docker-compose.yml" up -d web worker caddy
    if ($LASTEXITCODE -ne 0) { throw "Failed to start application services." }
}

function Extract-TLS {
    Write-Host "Extracting Caddy Root CA..."
    if (-not (Test-Path "$EnvDir\tls")) { New-Item -ItemType Directory -Path "$EnvDir\tls" | Out-Null }
    
    $maxAttempts = 30
    for ($i = 1; $i -le $maxAttempts; $i++) {
        try {
            docker cp caddy:/data/caddy/pki/authorities/local/root.crt "$EnvDir\tls\keygen-root-ca.crt" 2>$null
            if ($LASTEXITCODE -eq 0 -and (Test-Path "$EnvDir\tls\keygen-root-ca.crt")) {
                Write-Host "Root CA extracted to $EnvDir\tls\keygen-root-ca.crt" -ForegroundColor Green
                Write-Host "Import this CA into your Backend's trust store to connect securely." -ForegroundColor Yellow
                return
            }
        } catch {}
        Write-Host "Waiting for Caddy to generate TLS certificates..."
        Start-Sleep -Seconds 2
    }
    throw "Failed to extract TLS certificates from Caddy after 60 seconds. Check Caddy container logs."
}

function Validate {
    Write-Host "Validating Installation..."
    .\scripts\powershell\health.ps1
}

$state = Get-InstallState
$s = $state.State

try {
    if ($s -eq "PREFLIGHT") {
        Run-Preflight
        Set-InstallState "WINDOWS_FEATURES"
        $s = "WINDOWS_FEATURES"
    }
    if ($s -eq "WINDOWS_FEATURES") {
        Install-WindowsFeatures
        Install-WslKernel
        Set-InstallState "REBOOT_REQUIRED"
        Write-Host "A reboot is required to finish WSL installation. Please reboot, then run install.bat again." -ForegroundColor Yellow
        exit 0
    }
    if ($s -eq "REBOOT_REQUIRED") {
        # Check if actually rebooted or just re-run
        Set-InstallState "WSL_READY"
        $s = "WSL_READY"
    }
    if ($s -eq "WSL_READY") {
        Install-Docker
        Set-InstallState "DOCKER_INSTALLED"
        $s = "DOCKER_INSTALLED"
    }
    if ($s -eq "DOCKER_INSTALLED") {
        Verify-DockerReady
        Set-InstallState "DOCKER_READY"
        $s = "DOCKER_READY"
    }
    if ($s -eq "DOCKER_READY") {
        Import-Images
        Set-InstallState "IMAGES_READY"
        $s = "IMAGES_READY"
    }
    if ($s -eq "IMAGES_READY") {
        Generate-Config
        Set-InstallState "CONFIG_READY"
        $s = "CONFIG_READY"
    }
    if ($s -eq "CONFIG_READY") {
        Init-Database
        Set-InstallState "DATABASE_READY"
        $s = "DATABASE_READY"
    }
    if ($s -eq "DATABASE_READY") {
        Start-Services
        Set-InstallState "SERVICES_READY"
        $s = "SERVICES_READY"
    }
    if ($s -eq "SERVICES_READY") {
        Extract-TLS
        Set-InstallState "TLS_READY"
        $s = "TLS_READY"
    }
    if ($s -eq "TLS_READY") {
        Validate
        Set-InstallState "COMPLETE"
        Write-Host "Installation completed successfully!" -ForegroundColor Green
    }
} catch {
    Write-Host "Installation failed at state: $s" -ForegroundColor Red
    Write-Error $_
    exit 1
}
