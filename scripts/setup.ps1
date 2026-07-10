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
$envLocal  = Join-Path $owDir '.env.local'

# ── Compose project isolation ────────────────────────────────────────────────
# Docker volumes/networks are named "{project}_{resource}" -- a GLOBAL engine
# namespace, not scoped to this checkout's path. Without a unique project name,
# a second checkout of this repo anywhere on the same machine (a test clone, a
# coworker's fork, a throwaway eval) silently shares -- and can destroy -- the
# real dev environment's Postgres/Zitadel data. Derive one from this checkout's
# absolute path so isolation is automatic, not something anyone has to remember.
$md5 = [System.Security.Cryptography.MD5]::Create()
$hashBytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($owDir))
$pathHash = ([System.BitConverter]::ToString($hashBytes) -replace '-', '').Substring(0, 8).ToLower()
$owProjectName = if ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME } else { "openwind-$pathHash" }
$zitaProjectName = "zitadel-$pathHash"

function Banner($msg) { Write-Host "" ; Write-Host "  $msg" -ForegroundColor Cyan }
function Ok($msg)     { Write-Host "  [+] $msg" -ForegroundColor Green }
function Info($msg)   { Write-Host "  --> $msg" -ForegroundColor DarkGray }
function Fail($msg)   { Write-Host "" ; Write-Host "  [!] $msg" -ForegroundColor Red ; Write-Host "" ; exit 1 }

function New-RandomToken($length) {
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    -join (1..$length | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
}

function Get-EnvLocalValue($key) {
    if (-not (Test-Path $envLocal)) { return $null }
    $line = Select-String -Path $envLocal -Pattern "^$key=" -SimpleMatch:$false | Select-Object -First 1
    if (-not $line) { return $null }
    return ($line.Line -split '=', 2)[1]
}

Write-Host ""
Write-Host "  =============================================" -ForegroundColor Cyan
Write-Host "   OpenWind Setup" -ForegroundColor Cyan
Write-Host "  =============================================" -ForegroundColor Cyan
Write-Host ""

# ── Deployment config — override via environment for hosted deployments ──────
if (-not $env:ZITADEL_EXTERNAL_DOMAIN) { $env:ZITADEL_EXTERNAL_DOMAIN = 'localhost' }
if (-not $env:ZITADEL_HOST_PORT)       { $env:ZITADEL_HOST_PORT = '8080' }
if (-not $env:ZITADEL_EXTERNALSECURE)  { $env:ZITADEL_EXTERNALSECURE = 'false' }
if (-not $env:ZITADEL_TLS_MODE)        { $env:ZITADEL_TLS_MODE = 'disabled' }

if ($env:ZITADEL_EXTERNALSECURE -eq 'true') {
    $zitadelBrowserUrl = "https://$($env:ZITADEL_EXTERNAL_DOMAIN)"
} elseif ($env:ZITADEL_EXTERNAL_DOMAIN -ne 'localhost') {
    $zitadelBrowserUrl = "http://$($env:ZITADEL_EXTERNAL_DOMAIN):$($env:ZITADEL_HOST_PORT)"
} else {
    $zitadelBrowserUrl = "http://localhost:$($env:ZITADEL_HOST_PORT)"
}
$adminUiPort = if ($env:ADMIN_UI_HOST_PORT) { $env:ADMIN_UI_HOST_PORT } else { '3001' }
$openwindUrl = if ($env:APP_URL) { $env:APP_URL } else { "http://localhost:$adminUiPort" }

# ── Generated secrets (one-time, not persisted unless re-run) ────────────────
# If .env.local already has these (re-run scenario), reuse them so Zitadel's
# existing volume stays valid instead of getting wiped for nothing.
$existingMasterkey = Get-EnvLocalValue 'ZITADEL_MASTERKEY'
$existingAdminPass = Get-EnvLocalValue 'ZITADEL_ADMIN_PASSWORD'

if ($existingMasterkey -and $existingAdminPass) {
    $zitadelMasterkey   = $existingMasterkey
    $zitadelAdminPassword = $existingAdminPass
} else {
    $zitadelMasterkey     = New-RandomToken 32
    # 22 random alphanumeric chars + "@!" suffix satisfies Zitadel's default
    # complexity policy (upper/lower/number/symbol) and avoids $ / % that would
    # get mangled by Docker Compose variable interpolation.
    $zitadelAdminPassword = (New-RandomToken 22) + '@!'

    # docker writes to stderr and exits non-zero when the volume doesn't exist
    # (the common case on a truly fresh machine) — with $ErrorActionPreference
    # = 'Stop', PowerShell turns that into a terminating error even with
    # 2>$null, so temporarily relax it just for this check.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    docker volume inspect "${zitaProjectName}_zitadel_db_data" *> $null
    $staleVolumeExists = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prevEAP
    if ($staleVolumeExists) {
        Info "Removing stale Zitadel DB volume so Zitadel can reinitialise with new credentials..."
        docker volume rm "${zitaProjectName}_zitadel_db_data" *> $null
    }
}

$env:ZITADEL_MASTERKEY      = $zitadelMasterkey
$env:ZITADEL_ADMIN_PASSWORD = $zitadelAdminPassword

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
$composeYml = $composeYml -replace '__PROJECT_NAME__', $zitaProjectName

$composePath = Join-Path $zitaDir 'docker-compose.yml'
Set-Content -Path $composePath -Value $composeYml -Encoding utf8
Ok "docker-compose.yml written to $zitaDir"

# Step 2 -- Start Zitadel and generate PAT
Banner "Step 2/4  Starting Zitadel and generating bootstrap PAT"
Info "(First boot takes 60-90s while Zitadel initialises)"
Write-Host ""

Set-Location $zitaDir
# Switch to the zitadel project name -- COMPOSE_PROJECT_NAME (env var) beats a
# compose file's own `name:` field, so leaving owProjectName set here would
# silently redirect Zitadel's volume onto the openwind project instead.
$env:COMPOSE_PROJECT_NAME = $zitaProjectName

docker compose up -d
if ($LASTEXITCODE -ne 0) { Fail "Failed to start Zitadel containers" }

if (Test-Path $patFile) { Remove-Item $patFile -Force }

docker compose --profile setup run --rm ow-zita-setup
if ($LASTEXITCODE -ne 0) { Fail "PAT generation failed -- check: docker compose logs zitadel" }

Set-Location $owDir
# Switch back to the openwind project name for all subsequent commands.
$env:COMPOSE_PROJECT_NAME = $owProjectName

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

# Persist generated secrets for re-run idempotency (values already set above if re-run)
if (-not (Get-EnvLocalValue 'ZITADEL_MASTERKEY')) {
    Add-Content -Path '.env.local' -Value "`nZITADEL_MASTERKEY=$zitadelMasterkey`nZITADEL_ADMIN_PASSWORD=$zitadelAdminPassword"
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
Write-Host "   Done!" -ForegroundColor Green
Write-Host ""
Write-Host "   OpenWind:  $openwindUrl" -ForegroundColor White
Write-Host "   Zitadel:   $zitadelBrowserUrl" -ForegroundColor White
Write-Host "  =============================================" -ForegroundColor Green
Write-Host ""
Write-Host "   Zitadel admin (identity provider console):" -ForegroundColor White
Write-Host "     owZitadelAdmin@openwind.local / $zitadelAdminPassword" -ForegroundColor White
Write-Host ""
Write-Host "   OpenWind app:" -ForegroundColor White
Write-Host "     owAdmin / OpenWind1234!   (admin)" -ForegroundColor White
Write-Host "     owUser  / OpenWind1234!   (user)" -ForegroundColor White
Write-Host ""
Write-Host "   This checkout's Docker Compose project: $owProjectName" -ForegroundColor DarkGray
Write-Host "   (isolated per checkout path -- safe to run alongside other clones." -ForegroundColor DarkGray
Write-Host "    For ad-hoc 'docker compose ...' commands in a new terminal, run:" -ForegroundColor DarkGray
Write-Host "    `$env:COMPOSE_PROJECT_NAME = '$owProjectName')" -ForegroundColor DarkGray
Write-Host ""
