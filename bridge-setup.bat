@echo off
:: bridge-setup.bat — temporary bridge until the setup-hardening PR merges upstream.
:: Self-contained: fetches scripts\bridge-setup.ps1 (which doesn't exist yet on an
:: older fork) from the child branch first, then runs it.
if not exist "%~dp0scripts" mkdir "%~dp0scripts"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/TusharSharma991/OpenWind/child/scripts/bridge-setup.ps1' -OutFile '%~dp0scripts\bridge-setup.ps1' -UseBasicParsing"
if errorlevel 1 (
  echo [!] Failed to fetch scripts\bridge-setup.ps1
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bridge-setup.ps1"
exit /b %errorlevel%
