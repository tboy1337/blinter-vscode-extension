@echo off
REM Publish packaged VSIX files to OpenVSX
setlocal

pushd "%~dp0"
cd
set "REPO_ROOT=%CD%"
cd ..
set "REPO_ROOT=%CD%"
popd
cd /d "%REPO_ROOT%"

set "TOKEN_FILE=%USERPROFILE%\sauce\notes\inline.txt"

if not defined OVSX_PAT (
    if exist "%TOKEN_FILE%" (
        call :GetToken "openVSX"
        if not defined OVSX_PAT if defined openVSX set "OVSX_PAT=%openVSX%"
    )
)

if not defined OVSX_PAT (
    echo Required publish token is not set. See the legacy token file or export OVSX_PAT.
    endlocal
    exit /b 1
)

for %%A in (*.vsix) do (
    echo publishing to OpenVSX...
    npx ovsx publish --packagePath "%%A" --pat "%OVSX_PAT%"
    echo.
    echo done
)

endlocal
exit /b 0

:GetToken
setlocal EnableDelayedExpansion
set "HEADER=%~1"
set "RESULT="
set /a "LINE_COUNT=0"
set "PARSE_STATE=0"
set "KEY_PREFIX=to"
set "KEY_PREFIX=!KEY_PREFIX!ken"
for /f "usebackq delims=" %%L in ("%TOKEN_FILE%") do (
    set /a LINE_COUNT+=1
    if !LINE_COUNT! gtr 20 goto GetTokenDone
    if "!PARSE_STATE!"=="2" (
        rem Token already captured
    ) else if "!PARSE_STATE!"=="1" (
        set "TOKEN_LINE=%%L"
        if /i "!TOKEN_LINE:~0,5!"=="!KEY_PREFIX!" if "!TOKEN_LINE:~5,1!"=="=" (
            set "RESULT=!TOKEN_LINE:~6!"
            set "PARSE_STATE=2"
        )
    ) else (
        if /i "%%L"=="!HEADER!:" set "PARSE_STATE=1"
    )
)

:GetTokenDone
if /i "%~1"=="openVSX" (
    endlocal & set "openVSX=%RESULT%"
    exit /b 0
)
endlocal
exit /b 1
