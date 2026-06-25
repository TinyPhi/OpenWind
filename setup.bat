@echo off
:: OpenWind setup — single command to a running system.
:: Delegates all logic to scripts\setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
exit /b %errorlevel%
