#!/bin/bash
# Smoke-tests a built Mac helper the way someone gets it: copied out of the
# disk image, started by its vocalgraph:// link, then asked what the page
# asks. Used by .github/workflows/helper.yml.
#
#   bash helper/smoke-mac.sh helper/Output/VocalgraphHelper-<version>-mac-<chip>.dmg <version>
set -euo pipefail
DMG="$1"
VERSION="$2"
ORIGIN="https://vocalgraph.github.io"
H="http://127.0.0.1:8766"

MNT="$(mktemp -d)"
hdiutil attach -quiet -nobrowse -mountpoint "$MNT" "$DMG"
APP="$HOME/Applications/Vocalgraph Helper.app"
mkdir -p "$HOME/Applications"
rm -rf "$APP"
cp -R "$MNT/Vocalgraph Helper.app" "$APP"
test -L "$MNT/Applications"
hdiutil detach -quiet "$MNT"
BIN="$APP/Contents/MacOS/Vocalgraph Helper"
plutil -p "$APP/Contents/Info.plist"

# The link, as the page's Start button opens it.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
open "vocalgraph://start"
code=000
for _ in $(seq 60); do
    sleep 0.5
    code=$(curl -s -o version.json -w '%{http_code}' -H "Origin: $ORIGIN" "$H/version" || true)
    [ "$code" = 200 ] && break
done
if [ "$code" != 200 ]; then echo "GET /version didn't answer 200 (last: $code)"; exit 1; fi
echo "version: $(cat version.json)"
python3 -c '
import json, sys
v = json.load(open("version.json"))
assert v["version"] == sys.argv[1] and v["protocol"] == 1 and v["packaged"] and v["platform"] == "darwin", v
' "$VERSION"

bad=$(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: https://example.com' "$H/version")
if [ "$bad" != 403 ]; then echo "another origin got $bad, not 403"; exit 1; fi
none=$(curl -s -o /dev/null -w '%{http_code}' "$H/version")
if [ "$none" != 403 ]; then echo "no origin got $none, not 403"; exit 1; fi

# A second start (another click on the link) leaves the first one running.
open "vocalgraph://start"
sleep 2
test "$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $ORIGIN" "$H/version")" = 200

# The app list loads ScreenCaptureKit through PyObjC, inside the bundle.
# Without the Screen Recording permission the list holds one greyed-out
# entry explaining it, and the helper quits so the next start gets the
# permission once it's given.
code=$(curl -s --max-time 30 -o apps.json -w '%{http_code}' -H "Origin: $ORIGIN" "$H/apps" || true)
echo "apps ($code): $(cat apps.json 2>/dev/null)"
if [ "$code" != 200 ]; then exit 1; fi
python3 -c 'import json; assert isinstance(json.load(open("apps.json")), list)'
if python3 -c '
import json
apps = json.load(open("apps.json"))
raise SystemExit(0 if any(a.get("permission") for a in apps) else 1)
'; then
    echo "no permission here: the helper should quit by itself"
    sleep 3
else
    "$BIN" --quit
    sleep 1
fi
if lsof -nP -iTCP:8766 -sTCP:LISTEN; then echo 'still listening'; exit 1; fi
echo "--- helper.log"
cat "$HOME/Library/Logs/Vocalgraph Helper/helper.log"
