@echo off
rem Shared by the Windows install and start scripts. Keeps uv, Python and its
rem cache inside the app folder so deleting the folder removes everything.
set "APP_DIR=%~dp0.."
rem Pinned: end users get the uv version this release was tested with.
set "UV_VERSION=0.12.21"
set "UV_DIR=%APP_DIR%\.tools\uv"
set "UV=%UV_DIR%\uv.exe"
set "UV_PYTHON_INSTALL_DIR=%APP_DIR%\.tools\python"
set "UV_CACHE_DIR=%APP_DIR%\.tools\cache"
rem Use only the Python uv installs here, never one already on the machine.
set "UV_PYTHON_PREFERENCE=only-managed"
