@echo off
rem Starts Silence Trimmer and opens it in your browser. Close this window to quit.
setlocal
cd /d "%~dp0"
call "%~dp0scripts\uv-env.cmd"
if not exist "%UV%" (
    echo Silence Trimmer is not set up yet. Double-click "Install Silence Trimmer.cmd" first.
    pause
    exit /b 1
)
title Silence Trimmer
"%UV%" run --locked --offline python -m silence_trimmer
if errorlevel 1 pause
