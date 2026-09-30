# Shared by the macOS install and start scripts. Keeps uv, Python and its
# cache inside the app folder so deleting the folder removes everything.
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Pinned: end users get the uv version this release was tested with.
UV_VERSION="0.12.21"
UV_DIR="$APP_DIR/.tools/uv"
UV="$UV_DIR/uv"
export UV_PYTHON_INSTALL_DIR="$APP_DIR/.tools/python"
export UV_CACHE_DIR="$APP_DIR/.tools/cache"
# Use only the Python uv installs here, never one already on the machine.
export UV_PYTHON_PREFERENCE="only-managed"
