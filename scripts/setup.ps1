# setup.ps1 -- Full OpenWind setup orchestrator (called by setup.bat)
# Creates ../zitadel/ at runtime, pulls the official Zitadel image, generates a
# PAT, then runs the OpenWind bootstrap -- all in one shot.

param()
$ErrorActionPreference = 'Stop'

# Paths
$owDir     = Split-Path $PSScriptRoot -Parent
$zitaDir   = Join-Path (Split-Path $owDir -Parent) 'zitadel'
$outputDir = Join-Path $zitaDir 'output'
$patFile   = Join-Path $outputDir 'pat.txt'
$genPatSrc = Join-Path $owDir 'scripts\gen-pat.mjs'
$template  = Join-Path $owDir 'scripts\zitadel-compose-template.yml'

function Banner($msg) { Write-Host "" ; Write-Host "  $msg" -ForegroundColor Cyan }
function Ok($msg)     { Write-Host "  [+] $msg" -ForegroundColor Green }
function Info($msg)   { Write-Host "  --> $msg" -ForegroundColor DarkGray }
function Fail($msg)   { Write-Host "" ; Write-Host "  [!] $msg" -ForegroundColor Red ; Write-Host "" ; exit 1 }

Write-Host ""
Write-Host "  =============================================" -ForegroundColor Cyan
Write-Host "   OpenWind Setup" -ForegroundColor Cyan
Write-Host "  =============================================" -ForegroundColor Cyan
Write-Host ""

# Step 1 -- Create ../zitadel/ and write docker-compose.yml
Banner "Step 1/4  Setting up Zitadel identity provider"

if (-not (Test-Path $zitaDir)) {
    New-Item -ItemType Directory -Force $zitaDir | Out-Null
    New-Item -ItemType Directory -Force $outputDir | Out-Null
    Ok "Created $zitaDir"
} else {
    Info "Zitadel directory already exists -- skipping creation"
}

$genPatSrcFwd = $genPatSrc -replace '\\', '/'
$outputDirFwd = $outputDir -replace '\\', '/'

$composeYml = Get-Content $template -Raw
$composeYml = $composeYml -replace '__GEN_PAT_SRC__', $genPatSrcFwd
$composeYml = $composeYml -replace '__OUTPUT_DIR__', $outputDirFwd

$composePath = Join-Path $zitaDir 'docker-compose.yml'
Set-Content -Path $composePath -Value $composeYml -Encoding utf8
Ok "docker-compose.yml written to $zitaDir"

# Step 2 -- Start Zitadel and generate PAT
Banner "Step 2/4  Starting Zitadel and generating bootstrap PAT"
Info "(First boot takes 60-90s while Zitadel initialises)"
Write-Host ""

Set-Location $zitaDir

docker compose up -d
if ($LASTEXITCODE -ne 0) { Fail "Failed to start Zitadel containers" }

if (Test-Path $patFile) { Remove-Item $patFile -Force }

docker compose --profile setup run --rm ow-zita-setup
if ($LASTEXITCODE -ne 0) { Fail "PAT generation failed -- check: docker compose logs zitadel" }

Set-Location $owDir

if (-not (Test-Path $patFile)) { Fail "PAT file not found at $patFile -- gen-pat.mjs did not complete" }
$pat = (Get-Content $patFile -Raw).Trim()
if ([string]::IsNullOrEmpty($pat)) { Fail "PAT file is empty" }

Remove-Item $patFile -Force
Ok "PAT received (in memory -- not stored on disk)"
Write-Host ""

# Step 3 -- Run OpenWind bootstrap
Banner "Step 3/4  Running OpenWind bootstrap"
Info "(Migrations, seed data, Zitadel OIDC config, demo users)"
Write-Host ""

if (-not (Test-Path '.env.local' -PathType Leaf)) {
    if (Test-Path '.env.example') {
        Copy-Item '.env.example' '.env.local'
        Ok "Created .env.local from .env.example"
    } else {
        New-Item -ItemType File '.env.local' | Out-Null
    }
}

docker compose up -d postgres pgbouncer redis
if ($LASTEXITCODE -ne 0) { Fail "Failed to start infrastructure containers" }

docker compose --profile bootstrap run --build -e "ZITADEL_SETUP_PAT=$pat" --rm bootstrap
if ($LASTEXITCODE -ne 0) { Fail "Bootstrap failed -- check the output above" }

$pat = ''

# Step 4 -- Start app containers
Banner "Step 4/4  Starting app containers"

docker compose up -d --force-recreate ow-backend ow-frontend
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [!] Could not start app containers automatically." -ForegroundColor Yellow
    Write-Host "      Run manually: docker compose up -d ow-backend ow-frontend" -ForegroundColor Yellow
}

Ok "App containers started"

Write-Host ""
Write-Host "  =============================================" -ForegroundColor Green
Write-Host "   Done!  Open http://localhost:3001" -ForegroundColor Green
Write-Host "  =============================================" -ForegroundColor Green
Write-Host ""
Write-Host "   owAdmin / OpenWind1234!   (admin)" -ForegroundColor White
Write-Host "   owUser  / OpenWind1234!   (user)" -ForegroundColor White
Write-Host ""
