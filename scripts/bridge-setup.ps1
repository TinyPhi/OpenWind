# bridge-setup.ps1 -- temporary bridge until the setup-hardening PR merges upstream.
# Pulls the fixed setup files from the child branch (TusharSharma991/OpenWind)
# and overwrites the local (older) copies, then runs the real setup script.
#
# Usage: drop bridge-setup.bat (which calls this) in the OpenWind repo root and run it.
# Safe to delete once the PR merges -- nothing here is meant to be permanent.

param()
$ErrorActionPreference = 'Stop'

$RawBase = "https://raw.githubusercontent.com/TusharSharma991/OpenWind/child"
$owDir = Split-Path $PSScriptRoot -Parent
Set-Location $owDir

$files = @(
    "setup.sh",
    "setup.bat",
    "scripts/setup.ps1",
    "scripts/zitadel-compose-template.yml",
    "scripts/bootstrap.ts",
    "docker-compose.yml"
)

Write-Host ""
Write-Host "  =============================================" -ForegroundColor Cyan
Write-Host "   Bridge setup -- fetching fixed setup files" -ForegroundColor Cyan
Write-Host "   from child branch (pre-merge)" -ForegroundColor Cyan
Write-Host "  =============================================" -ForegroundColor Cyan
Write-Host ""

# Add this bridge script (and its Linux/Mac counterpart) to .gitignore, once.
$gitignoreEntries = @("bridge-setup.sh", "bridge-setup.bat", "scripts/bridge-setup.ps1")
$gitignorePath = Join-Path $owDir ".gitignore"
if (-not (Test-Path $gitignorePath)) { New-Item -ItemType File $gitignorePath | Out-Null }
$existing = Get-Content $gitignorePath -Raw -ErrorAction SilentlyContinue
foreach ($entry in $gitignoreEntries) {
    if ($existing -notmatch [regex]::Escape($entry)) {
        Add-Content -Path $gitignorePath -Value $entry
    }
}
Write-Host "  [+] .gitignore updated" -ForegroundColor Green

foreach ($f in $files) {
    Write-Host "  --> Fetching $f" -ForegroundColor DarkGray
    $destDir = Split-Path $f -Parent
    if ($destDir -and -not (Test-Path $destDir)) { New-Item -ItemType Directory -Force $destDir | Out-Null }
    $tmp = "$f.tmp"
    try {
        Invoke-WebRequest -Uri "$RawBase/$f" -OutFile $tmp -UseBasicParsing
    } catch {
        Write-Host "  [!] Failed to fetch $f" -ForegroundColor Red
        exit 1
    }
    Move-Item -Force $tmp $f
}

Write-Host ""
Write-Host "  [+] Files replaced with fixed versions" -ForegroundColor Green
Write-Host ""
Write-Host "  =============================================" -ForegroundColor Cyan
Write-Host "   Running setup" -ForegroundColor Cyan
Write-Host "  =============================================" -ForegroundColor Cyan
Write-Host ""

& "$owDir\setup.bat"
exit $LASTEXITCODE
