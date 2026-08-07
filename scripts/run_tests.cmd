@echo off
REM Run the same validation steps as .github/workflows/ci.yml
setlocal

pushd "%~dp0"
cd
set "REPO_ROOT=%CD%"
cd ..
set "REPO_ROOT=%CD%"
popd
cd /d "%REPO_ROOT%"

set "LOGFILE=project_logs.log"

(
    echo ========================================
    echo CI-equivalent test run started: %DATE% %TIME%
    echo ========================================
) > "%LOGFILE%"

echo [1/15] Install PowerShell modules (Pester, PSScriptAnalyzer)
echo [1/15] Install PowerShell modules (Pester, PSScriptAnalyzer) >> "%LOGFILE%"
powershell -NoProfile -ExecutionPolicy RemoteSigned -Command "Set-PSRepository PSGallery -InstallationPolicy Trusted; Install-Module Pester, PSScriptAnalyzer -Force -Scope CurrentUser -SkipPublisherCheck" >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [2/15] PowerShell lint (PSScriptAnalyzer)
echo [2/15] PowerShell lint (PSScriptAnalyzer) >> "%LOGFILE%"
call npm.cmd run lint:powershell >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [3/15] PowerShell tests (Pester ^>=95%% coverage)
echo [3/15] PowerShell tests (Pester ^>=95%% coverage) >> "%LOGFILE%"
call npm.cmd run test:powershell >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [4/15] Setup vendor binary
echo [4/15] Setup vendor binary >> "%LOGFILE%"
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "./scripts/setup-vendor.ps1" >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [5/15] Lint (ESLint)
echo [5/15] Lint (ESLint) >> "%LOGFILE%"
call npm.cmd run lint >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [6/15] Typecheck
echo [6/15] Typecheck >> "%LOGFILE%"
call npm.cmd run typecheck >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [7/15] Security scan (static)
echo [7/15] Security scan (static) >> "%LOGFILE%"
call npm.cmd run test:security >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [8/15] Coverage gate (^>=95%%)
echo [8/15] Coverage gate (^>=95%%) >> "%LOGFILE%"
call npm.cmd run test:coverage >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [9/15] Performance checks
echo [9/15] Performance checks >> "%LOGFILE%"
call npm.cmd run test:performance >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [10/15] UAT checks
echo [10/15] UAT checks >> "%LOGFILE%"
call npm.cmd run test:uat >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [11/15] Security audit (production deps)
echo [11/15] Security audit (production deps) >> "%LOGFILE%"
call npm.cmd run test:security:audit >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [12/15] Security audit (dev deps)
echo [12/15] Security audit (dev deps) >> "%LOGFILE%"
call npm.cmd run audit:dev >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [13/15] Extension integration tests
echo [13/15] Extension integration tests >> "%LOGFILE%"
set "BLINTER_INTEGRATION_ONLY=1"
call npm.cmd test >> "%LOGFILE%" 2>&1
set "BLINTER_INTEGRATION_ONLY="
if errorlevel 1 goto RunTestsFail

echo [14/15] Package VSIX
echo [14/15] Package VSIX >> "%LOGFILE%"
call npm.cmd run package:vsix >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo [15/15] Verify VSIX contents
echo [15/15] Verify VSIX contents >> "%LOGFILE%"
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "./tools/verify-vsix.ps1" >> "%LOGFILE%" 2>&1
if errorlevel 1 goto RunTestsFail

echo. >> "%LOGFILE%"
echo ======================================== >> "%LOGFILE%"
echo CI-equivalent test run completed: %DATE% %TIME% >> "%LOGFILE%"
echo ======================================== >> "%LOGFILE%"

echo All CI-equivalent checks passed. Full log: %LOGFILE%
endlocal
exit /b 0

:RunTestsFail
echo Test run failed. See %LOGFILE% for details.
endlocal
exit /b 1
