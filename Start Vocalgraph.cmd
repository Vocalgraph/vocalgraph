@echo off
rem Starts Vocalgraph and opens it in your browser. Close this window to quit.
setlocal
cd /d "%~dp0"
call "%~dp0scripts\uv-env.cmd"
if not exist "%UV%" (
    echo Vocalgraph is not set up yet. Double-click "Install Vocalgraph.cmd" first.
    pause
    exit /b 1
)
title Vocalgraph
"%UV%" run --locked --offline python -m vocalgraph
if errorlevel 1 pause
