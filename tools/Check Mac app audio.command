#!/bin/bash
# Checks that Silence Trimmer can record one app's sound on this Mac (untested
# so far), and writes mac-app-audio-check.txt in the Silence Trimmer folder to
# send back. Start something playing in the app you want to test first.
cd "$(dirname "$0")/.."
source scripts/uv-env.sh
if [ ! -x "$UV" ]; then
    echo 'Silence Trimmer is not set up yet. Open "Install Silence Trimmer.command" first.'
    read -n 1 -s -r -p "Press any key to close."
    exit 1
fi
echo "Which app should it record? Type part of its name (for example: Music, Safari, Zoom),"
read -r -p "with something playing in it now: " APP
"$UV" run --locked python tools/mac_app_audio_check.py "$APP"
echo
read -n 1 -s -r -p "Press any key to close."
