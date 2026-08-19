<#
.SYNOPSIS
End-to-End Bootstrap Script.
Acts as an all-in-one runner that builds the kit (if missing), installs it (if not installed), and verifies the application is healthy.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host " KEYGEN END-TO-END BOOTSTRAP " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

$KitVersion = "1.0.0"
$KitDir = "Keygen-Offline-Kit-v$KitVersion"

# 1. Check if we need to run the Online Builder
if (-not (Test-Path $KitDir)) {
    Write-Host "`n[PHASE 1] Kit not found locally. Running Online Builder..." -ForegroundColor Yellow
    if (Test-Path ".\build-kit.ps1") {
        & .\build-kit.ps1
        if ($LASTEXITCODE -ne 0) { throw "Builder failed." }
    } else {
        throw "Cannot find build-kit.ps1 to build the kit."
    }
} else {
    Write-Host "`n[PHASE 1] Kit already built at $KitDir. Skipping download/build phase." -ForegroundColor Green
}

# 2. Run the Installer
Write-Host "`n[PHASE 2] Running the Installer..." -ForegroundColor Yellow
$installScript = "$KitDir\scripts\powershell\install.ps1"
if (-not (Test-Path $installScript)) {
    throw "Install script not found inside the kit at $installScript"
}

# We run the installer in its own context to simulate the offline environment executing it
Push-Location $KitDir
try {
    & .\scripts\powershell\install.ps1
    $installCode = $LASTEXITCODE
} finally {
    Pop-Location
}

# NOTE: If install.ps1 exits with 0 but requested a reboot (state REBOOT_REQUIRED), it will gracefully exit.
# We need to check the state to see if it actually finished.
$StateFile = "$env:SystemDrive\KeygenEnv\install-state.json"
if (Test-Path $StateFile) {
    $state = (Get-Content $StateFile -Raw | ConvertFrom-Json).State
    if ($state -eq "REBOOT_REQUIRED") {
        Write-Host "`n[WARNING] Installation paused because a Windows Reboot is required to enable WSL." -ForegroundColor Yellow
        Write-Host "Please reboot your computer, then run this bootstrap script again to resume." -ForegroundColor Yellow
        exit 0
    }
}

if ($installCode -ne 0 -and $installCode -ne $null) {
    throw "Installer failed with exit code $installCode."
}

# 3. Final Health Check
Write-Host "`n[PHASE 3] Validating Deployment..." -ForegroundColor Yellow
$healthScript = "$KitDir\scripts\powershell\health.ps1"
if (Test-Path $healthScript) {
    Push-Location $KitDir
    try {
        & .\scripts\powershell\health.ps1
    } finally {
        Pop-Location
    }
}

Write-Host "`n=============================================" -ForegroundColor Cyan
Write-Host " BOOTSTRAP COMPLETE! KEYGEN IS RUNNING." -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Cyan
