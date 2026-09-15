#!/usr/bin/env bash
# Builds GS Distributor for release and packs it into a disk image for installing on another Mac:
# open the image and drag the app onto Applications. The build is stamped with the time it was
# made, in the image's name and in the app's build number (its About window shows it), so the copy
# installed can be told apart from the next. The app is signed ad hoc, not by a registered
# developer, so its first launch on another Mac has to be allowed once in System Settings; the
# image's Read Me says how. The debug harness is not in this build.
#   scripts/package.sh [output folder, default ~/Desktop]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodegen
require xcodebuild
require hdiutil
cd "$DISTRIBUTOR_ROOT"

OUT="${1:-$HOME/Desktop}"
STAMP="$(date '+%Y-%m-%d %H.%M')"
BUILD="$(date '+%Y%m%d.%H%M')"
LOG="$DISTRIBUTOR_ROOT/DerivedData/package.log"
mkdir -p "$DISTRIBUTOR_ROOT/DerivedData" "$OUT"
xcodegen generate >/dev/null
log "Building GS Distributor (Release), build $BUILD"
if ! xcodebuild -project Distributor.xcodeproj -scheme Distributor -configuration Release \
  -derivedDataPath "$DISTRIBUTOR_ROOT/DerivedData" CURRENT_PROJECT_VERSION="$BUILD" build >"$LOG" 2>&1; then
  grep -E "error:" "$LOG" | head -20 || tail -30 "$LOG"
  fail "build failed; full log at $LOG"
fi

APP="$DISTRIBUTOR_ROOT/DerivedData/Build/Products/Release/GS Distributor.app"
[ -d "$APP" ] || fail "the build left no app at $APP"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/GS Distributor.app"
ln -s /Applications "$STAGE/Applications"
cat >"$STAGE/Read Me.txt" <<EOF
GS Distributor, built $STAMP (build $BUILD; GS Distributor > About GS Distributor shows it)

1. Drag GS Distributor onto Applications.

2. Open it from Applications. The first time, macOS says it cannot check the app, because it
   is not signed by a registered developer. Click Done, open System Settings > Privacy &
   Security, find "GS Distributor was blocked", and click Open Anyway. This is needed once.
   (Or, in Terminal: xattr -dr com.apple.quarantine "/Applications/GS Distributor.app")

3. Plug the iPad in with a USB-C cable, tap Trust on the iPad if it asks, and open GS Director
   on it, in front.

GS Distributor's settings live on the iPad, so on a new Mac the only thing to set is the folder
to save into (the gear at the top right). Needs macOS 15 or later, on Apple silicon or Intel.
EOF

DMG="$OUT/GS Distributor $STAMP.dmg"
rm -f "$DMG"
hdiutil create -volname "GS Distributor" -srcfolder "$STAGE" -format UDZO -ov "$DMG" >/dev/null
log "Made $DMG"
