#!/bin/sh
# A copy of a built simulator app that can only be landscape.
#
# There is no way to rotate an iOS simulator from a script: `simctl` has no
# orientation verb, `idb` is not installed here, and AppleScript can read the
# Simulator's menus but its clicks are silently ignored. Removing portrait
# from the supported orientations leaves iOS no choice, which is the only
# way the landscape layout gets tested at all.
#
# Regenerate it after every build. A hand-made copy goes stale silently, and
# a QA pass against a stale bundle is worse than no pass.
#
#   tools/makeLandscapeApp.sh <path-to-built.app> [dest]
set -e
SRC="$1"
DST="${2:-/tmp/TeamStation-landscape.app}"
[ -d "$SRC" ] || { echo "no app at $SRC" >&2; exit 1; }
rm -rf "$DST"
cp -R "$SRC" "$DST"
P="$DST/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :UISupportedInterfaceOrientations" "$P" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations array" "$P"
/usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations: string UIInterfaceOrientationLandscapeLeft" "$P"
/usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations: string UIInterfaceOrientationLandscapeRight" "$P"
codesign --force --sign - "$DST" >/dev/null 2>&1
echo "landscape-only copy of $(basename "$SRC") at $DST"
