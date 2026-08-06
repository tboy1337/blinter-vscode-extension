@echo off
setlocal

echo [Blinter] Running vendor setup via setup-vendor.ps1...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-vendor.ps1"
if %ERRORLEVEL% neq 0 (
    echo [Error] Vendor setup failed.
    exit /b %ERRORLEVEL%
)

echo [Blinter] Vendor setup complete.
exit /b 0
