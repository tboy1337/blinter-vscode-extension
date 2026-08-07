@echo off
REM Publish packaged VSIX files to OpenVSX and the VS Code Marketplace
setlocal

pushd "%~dp0"
cd
set "REPO_ROOT=%CD%"
cd ..
set "REPO_ROOT=%CD%"
popd
cd /d "%REPO_ROOT%"

set "TOKEN_FILE=%USERPROFILE%\sauce\notes\inline.txt"
set "VERSION_INFO_FILE=version.txt"
set "NOTES_FILE=release_notes.md"

if not defined OVSX_PAT if not defined VSCE_PAT (
    if exist "%TOKEN_FILE%" (
        call :GetToken "openVSX"
        if not defined OVSX_PAT if defined openVSX set "OVSX_PAT=%openVSX%"
        call :GetToken "vsce_azureGod"
        if not defined VSCE_PAT if defined vsce_azureGod set "VSCE_PAT=%vsce_azureGod%"
    )
)

if not defined OVSX_PAT (
    echo Required publish token is not set. See the legacy token file or export OVSX_PAT.
    endlocal
    exit /b 1
)
if not defined VSCE_PAT (
    echo Required marketplace token is not set. See the legacy token file or export VSCE_PAT.
    endlocal
    exit /b 1
)

if not exist "%VERSION_INFO_FILE%" (
    echo Missing %VERSION_INFO_FILE%. Run scripts\build.cmd first.
    endlocal
    exit /b 1
)
if not exist "%NOTES_FILE%" (
    echo Missing %NOTES_FILE%. Create release notes before publishing.
    endlocal
    exit /b 1
)

for /f "usebackq delims=" %%A in ("%VERSION_INFO_FILE%") do set "VERSION_LINE=%%A"
for /f "tokens=1,2,3 delims=." %%B in ("%VERSION_LINE%") do (
    set "VERSION=%%B.%%C.%%D"
    set "TAG=%%C.%%D"
)

for %%A in (*.vsix) do call :PublishVsix "%%A"

echo done
endlocal
exit /b 0

:PublishVsix
set "VSIX_FILE=%~1"
echo publishing to OpenVSX...
npx ovsx publish --packagePath "%VSIX_FILE%" --pat "%OVSX_PAT%"
echo.
echo publishing to VS Code Marketplace
npx vsce publish --packagePath "%VSIX_FILE%" --pat "%VSCE_PAT%"
echo.
echo publishing github release
gh release create "%TAG%" --notes-file "%NOTES_FILE%" --title "v%VERSION%" --draft
gh release upload "%TAG%" "%VSIX_FILE%"
gh release edit "%TAG%" --draft=false --latest
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
if /i "%~1"=="vsce_azureGod" (
    endlocal & set "vsce_azureGod=%RESULT%"
    exit /b 0
)
endlocal
exit /b 1
