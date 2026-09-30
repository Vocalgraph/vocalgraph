@echo off
rem Sets up Silence Trimmer in this folder. Double-click to run.
rem
rem Everything - the uv tool, Python, and the packages - goes inside this
rem folder, pinned to tested versions (uv below, Python in .python-version,
rem packages in uv.lock). Nothing is added to PATH. Delete the folder to
rem uninstall.
setlocal
cd /d "%~dp0"
call "%~dp0scripts\uv-env.cmd"

if not exist "%UV%" (
    echo Downloading uv %UV_VERSION%...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$env:UV_INSTALL_DIR='%UV_DIR%'; $env:UV_NO_MODIFY_PATH='1'; irm https://astral.sh/uv/%UV_VERSION%/install.ps1 | iex"
    if not exist "%UV%" goto :failed
)

echo.
echo Installing Python and the app's packages. The first time takes a minute or two...
"%UV%" sync --locked
if errorlevel 1 goto :failed
rem The download cache is not needed once installed; drop it to save space.
"%UV%" cache clean >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'Silence Trimmer.lnk'));" ^
    "$s.TargetPath='%~dp0Start Silence Trimmer.cmd'; $s.WorkingDirectory='%~dp0'; $s.Save()"

echo.
echo Done. Start it with the "Silence Trimmer" shortcut on your desktop,
echo or double-click "Start Silence Trimmer.cmd" in this folder.
pause
exit /b 0

:failed
echo.
echo Setup did not finish. Check your internet connection and run this again.
echo If it keeps failing, send the text above to whoever gave you this.
pause
exit /b 1
