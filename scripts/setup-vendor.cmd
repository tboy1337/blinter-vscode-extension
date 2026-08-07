@echo off
REM Setup vendored Blinter.exe via setup-vendor.ps1

echo [Blinter] Running vendor setup via setup-vendor.ps1...
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0setup-vendor.ps1"
if errorlevel 1 (
    echo [Error] Vendor setup failed.
    exit /b 1
)

echo [Blinter] Vendor setup complete.
exit /b 0
