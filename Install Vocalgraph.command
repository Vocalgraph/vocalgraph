#!/bin/bash
# Sets up Vocalgraph in this folder (macOS). Double-click to run; the
# first time, right-click it and choose Open instead, so macOS will allow it.
#
# Everything - the uv tool, Python, and the packages - goes inside this folder,
# pinned to tested versions (uv in scripts/uv-env.sh, Python in .python-version,
# packages in uv.lock). Nothing is added to PATH. Delete the folder to uninstall.
set -e
cd "$(dirname "$0")"
source scripts/uv-env.sh

fail() {
    echo
    echo "Setup did not finish. Check your internet connection and run this again."
    echo "If it keeps failing, send the text above to whoever gave you this."
    read -n 1 -s -r -p "Press any key to close."
    exit 1
}
trap fail ERR

if [ ! -x "$UV" ]; then
    echo "Downloading uv $UV_VERSION..."
    curl -LsSf "https://astral.sh/uv/$UV_VERSION/install.sh" |
        env UV_INSTALL_DIR="$UV_DIR" UV_NO_MODIFY_PATH=1 sh
fi

echo
echo "Installing Python and the app's packages. The first time takes a minute or two..."
"$UV" sync --locked
# The download cache is not needed once installed; drop it to save space.
"$UV" cache clean >/dev/null 2>&1 || true
chmod +x "Start Vocalgraph.command" "tools/Check Mac app audio.command"

echo
echo 'Done. Start it by double-clicking "Start Vocalgraph.command" in this folder.'
read -n 1 -s -r -p "Press any key to close."
