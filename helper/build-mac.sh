#!/bin/bash
# Builds the Vocalgraph Helper for macOS: the app with PyInstaller, then a
# disk image (the app beside a link to Applications) with a SHA-256 file.
# Run from anywhere on a Mac; used as-is by .github/workflows/helper.yml.
#
#   bash helper/build-mac.sh
#
# The chip type is the one of the Python that runs it: arm64 (Apple Silicon)
# or x86_64 (Intel). uv comes from $UV or PATH. PyInstaller, numpy and the
# ScreenCaptureKit bindings are the "helper" dependency group (pinned in
# uv.lock), added to the environment without removing anything.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
UV="${UV:-uv}"
cd "$ROOT"

"$UV" sync --locked --inexact --only-group helper
"$UV" run --locked --no-sync pyinstaller --noconfirm --distpath "$HERE/dist" --workpath "$HERE/build" \
    "$HERE/vocalgraph-helper-mac.spec"
APP="$HERE/dist/Vocalgraph Helper.app"
VERSION="$(sed -nE 's/^VERSION = "([0-9.]+)"/\1/p' vocalgraph/helper.py)"
ARCH="$(lipo -archs "$APP/Contents/MacOS/Vocalgraph Helper")"
case "$ARCH" in
    arm64) CHIP=apple-silicon ;;
    x86_64) CHIP=intel ;;
    *) echo "unexpected architecture: $ARCH" >&2; exit 1 ;;
esac
echo "Built $APP ($ARCH, $(du -sh "$APP" | cut -f1))"
codesign --verify --deep --strict "$APP"           # ad hoc, but whole: macOS refuses broken signatures

OUT="$HERE/Output"
rm -rf "$OUT" && mkdir -p "$OUT/image"
cp -R "$APP" "$OUT/image/"
ln -s /Applications "$OUT/image/Applications"
DMG="VocalgraphHelper-$VERSION-mac-$CHIP.dmg"
hdiutil create -quiet -volname "Vocalgraph Helper" -srcfolder "$OUT/image" -fs HFS+ -format UDZO "$OUT/$DMG"
rm -rf "$OUT/image"
( cd "$OUT" && shasum -a 256 -b "$DMG" > "$DMG.sha256" )   # sha256sum's format, so `sha256sum -c` checks it
echo "Built $OUT/$DMG"
cat "$OUT/$DMG.sha256"
