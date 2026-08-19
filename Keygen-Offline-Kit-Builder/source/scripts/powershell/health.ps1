<#
.SYNOPSIS
Executes health checks for the Keygen stack.
#>
$EnvDir = "$env:SystemDrive\KeygenEnv"
$fail = $false

Write-Host "Running Health Checks..."

# Postgres
try {
    docker exec postgres pg_isready -U keygen | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "[PASS] Postgres is accepting connections." -ForegroundColor Green }
    else { Write-Host "[FAIL] Postgres is not ready." -ForegroundColor Red; $fail = $true }
} catch { Write-Host "[FAIL] Postgres container not running." -ForegroundColor Red; $fail = $true }

# Redis
try {
    docker exec redis redis-cli ping | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "[PASS] Redis is accepting connections." -ForegroundColor Green }
    else { Write-Host "[FAIL] Redis is not ready." -ForegroundColor Red; $fail = $true }
} catch { Write-Host "[FAIL] Redis container not running." -ForegroundColor Red; $fail = $true }

# Application Health via Caddy
try {
    [Net.ServicePointManager]::ServerCertificateValidationCallback = {$true} # Ignore self-signed for local test
    $response = Invoke-WebRequest -Uri "https://127.0.0.1/v1/health" -Method Get -SkipCertificateCheck -UseBasicParsing -ErrorAction Stop
    if ($response.StatusCode -eq 204 -or $response.StatusCode -eq 200) {
        Write-Host "[PASS] Keygen API is healthy (HTTP $($response.StatusCode))." -ForegroundColor Green
    } else {
        Write-Host "[FAIL] Keygen API returned unexpected HTTP $($response.StatusCode)." -ForegroundColor Red
        $fail = $true
    }
} catch {
    Write-Host "[FAIL] Keygen API is unreachable via Caddy. Details: $($_.Exception.Message)" -ForegroundColor Red
    $fail = $true
}

if ($fail) { throw "One or more health checks failed." }
Write-Host "System is fully healthy." -ForegroundColor Cyan
