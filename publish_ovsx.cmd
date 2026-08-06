@echo off
setlocal enabledelayedexpansion

set "file=%userprofile%\sauce\notes\inline.txt"
call :GetToken "openVSX"

for %%a in (*.vsix) do (
    echo publishing to OpenVSX...
    npx ovsx publish --packagePath "%%a" --pat "%openVSX%"
    echo.
    echo done
)
endlocal
pause
goto :eof

:GetToken
    setlocal enabledelayedexpansion
    set "HEADER=%~1"
    set "RESULT="
    set /a "count=0"
    set "STATE=0"
    for /f "usebackq delims=" %%L in ("%file%") do (
        set /a count+=1
        if !count! gtr 20 goto :break
        if "!STATE!"=="2" (
            rem skip
        ) else if "!STATE!"=="1" (
            set "LINE=%%L"
            if "!LINE:~0,6!"=="token=" (
                set "RESULT=!LINE:~6!"
                set "STATE=2"
            )
        ) else (
            if "%%L"=="!HEADER!:" (
                set "STATE=1"
            )
        )
    )
    :break
    endlocal & set "%~1=%RESULT%"
    exit /b
