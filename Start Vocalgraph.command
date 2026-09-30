#!/bin/bash
# Starts Vocalgraph and opens it in your browser. Close this window to quit.
cd "$(dirname "$0")"
source scripts/uv-env.sh
if [ ! -x "$UV" ]; then
    echo 'Vocalgraph is not set up yet. Open "Install Vocalgraph.command" first.'
    read -n 1 -s -r -p "Press any key to close."
    exit 1
fi
"$UV" run --locked --offline python -m vocalgraph
