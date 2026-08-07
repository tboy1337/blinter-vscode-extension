@echo off
REM Build a versioned VSIX package and write version.txt
setlocal EnableDelayedExpansion

pushd "%~dp0"
cd
set "REPO_ROOT=%CD%"
cd ..
set "REPO_ROOT=%CD%"
popd
cd /d "%REPO_ROOT%"

if not exist releases mkdir releases
for %%D in (*.vsix) do set "OLD_BLINTER=%%D"
if defined OLD_BLINTER (
    move /Y "%OLD_BLINTER%" releases\
    if errorlevel 1 (
        echo Failed to move "%OLD_BLINTER%" to releases.
        endlocal
        exit /b 1
    )
) else (
    echo No .vsix file found to move.
)

set "PATCH=0"
set /p "PATCH=enter the patch number (0-9): "

REM Build version segment from current date
for /f "tokens=1,2,3 delims=/" %%A in ('date /t') do (
    set "DD=%%A"
    if "!DD:~0,1!"=="0" set "DD=!DD:~1!"
    set /a "DD=(!DD!*100)/32"
    if !DD! lss 10 set "DD=0!DD!"
    set "MM=%%B"
    if "!MM:~0,1!"=="0" set "MM=!MM:~1!"
    set /a "MM=(!MM!*100)/13"
    if !MM! lss 10 set "MM=0!MM!"
    set "YY=%%C"
    set "YY=!YY:~2,2!"
    set "X=!YY!.!MM!!DD!!PATCH!"
)

echo _!X!_
pause

REM Build build number from current time
for /f "tokens=1,2,3 delims=:" %%A in ('time /t') do (
    set "HH=%%B"
    if "!HH:~0,1!"=="0" set "HH=!HH:~1!"
    set "Y=!HH!"
)

if not defined X set "X=0.0"
if not defined Y set "Y=00"

echo writing version info...
ren "package.json" "package0.json"
set /a "COUNT=0"
for /f "usebackq delims=" %%A in ("package0.json") do (
    set /a COUNT+=1
    set "LINE=%%A"
    if !COUNT! lss 7 (
        echo !LINE! | find /i "version" >nul
        if not errorlevel 1 (
            set "VERSION_VALUE=1.!X!"
            echo !VERSION_VALUE!>version.txt
            echo   "version": "!VERSION_VALUE!",> .blinter-version-line.tmp
            set /p "LINE="<".blinter-version-line.tmp"
            if exist .blinter-version-line.tmp del .blinter-version-line.tmp
        )
    )
    echo !LINE!>>package.json
)

del package0.json
if errorlevel 1 (
    echo Failed to remove package0.json
    endlocal
    exit /b 1
)

call npm run package:vsix
if errorlevel 1 (
    echo build failed
    endlocal
    exit /b 1
)

if not exist blinter.vsix (
    echo build failed
    endlocal
    exit /b 1
)

set "OUTPUT_NAME=blinter_v1.!X!-build!Y!.vsix"
ren "blinter.vsix" "!OUTPUT_NAME!"

endlocal
exit /b 0
