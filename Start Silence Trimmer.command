#!/bin/bash
# Starts Silence Trimmer and opens it in your browser. Close this window to quit.
cd "$(dirname "$0")"
source scripts/uv-env.sh
if [ ! -x "$UV" ]; then
    echo 'Silence Trimmer is not set up yet. Open "Install Silence Trimmer.command" first.'
    read -n 1 -s -r -p "Press any key to close."
    exit 1
fi
"$UV" run --locked --offline python -m silence_trimmer
