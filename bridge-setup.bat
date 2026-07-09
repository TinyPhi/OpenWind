@echo off
:: bridge-setup.bat — temporary bridge until the setup-hardening PR merges upstream.
:: Delegates all logic to scripts\bridge-setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bridge-setup.ps1"
exit /b %errorlevel%
