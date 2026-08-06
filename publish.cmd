@echo off

setlocal enabledelayedexpansion


set "file=%userprofile%\sauce\notes\inline.txt"
set "versionInfoFile=version.txt"
set "notesFile=release_notes.md"


call :GetToken "openVSX"
call :GetToken "vsce_azureGod"


for /f "delims=" %%a in (%versionInfoFile%) do (
    set "line0=%%a"
    for /f "tokens=1,2,3 delims=." %%b in ("!line0!") do (
        set "version=%%b.%%c.%%d"
        set "tag=%%c.%%d"
    )
)

for %%a in (*.vsix) do (
    echo publishing to OpenVSX...
    npx ovsx publish --packagePath %%a --pat %openVSX%
    echo.
    echo publishing to VS Code Marketplace
    npx vsce publish --packagePath %%a --pat %vsce_azureGod%
    echo.
    echo publishing github release
    gh release create "%tag%" --notes-file "%notesFile%" --title "v%version%" --draft
    gh release upload "%tag%" %%a
    gh release edit "%tag%" --draft=false --latest

)
echo done
endlocal
pause
goto :eof



:: ============================================================
:: FUNCTION GetToken
:: PARAM 1 - the header label without the colon eg platform_1
:: PARAM 2 - the name of the variable to store the result in
:: ============================================================
:GetToken
    setlocal enabledelayedexpansion

    set "HEADER=%~1"
    set "RESULT="
    set /a "count=0"
    :: 0 = scanning for header
    :: 1 = header matched - watch for token= line
    :: 2 = token captured - skip rest
    set "STATE=0"

    for /f "usebackq delims=" %%L in ("%file%") do (
        set /a count+=1
        if !count! gtr 20 goto :break
        if "!STATE!"=="2" (
            rem token already captured skip line
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

    :: pass result out of the local scope into the callers variable
    endlocal & set "%~1=%RESULT%"
    exit /b
