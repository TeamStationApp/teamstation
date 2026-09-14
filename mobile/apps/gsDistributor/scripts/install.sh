#!/usr/bin/env bash
# Builds GS Distributor for release and puts it in /Applications, replacing an older copy, so it
# launches like any other app. The debug harness is not in this build.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodegen
require xcodebuild
cd "$DISTRIBUTOR_ROOT"

LOG="$DISTRIBUTOR_ROOT/DerivedData/install.log"
mkdir -p "$DISTRIBUTOR_ROOT/DerivedData"
xcodegen generate >/dev/null
log "Building GS Distributor (Release)"
if ! xcodebuild -project Distributor.xcodeproj -scheme Distributor -configuration Release \
  -derivedDataPath "$DISTRIBUTOR_ROOT/DerivedData" build >"$LOG" 2>&1; then
  grep -E "error:" "$LOG" | head -20 || tail -30 "$LOG"
  fail "build failed; full log at $LOG"
fi

APP="$DISTRIBUTOR_ROOT/DerivedData/Build/Products/Release/GS Distributor.app"
[ -d "$APP" ] || fail "the build left no app at $APP"

# A running copy is quit first; its files are about to be replaced.
osascript -e 'tell application id "co.gamestation.distributor" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 40); do
  pgrep -f "GS Distributor.app/Contents/MacOS" >/dev/null || break
  sleep 0.25
done
# AppKit will not quit while a sheet is up; the app is not replaced under a running copy.
if pgrep -f "GS Distributor.app/Contents/MacOS" >/dev/null; then
  fail "GS Distributor is still running (a sheet may be open): close it, quit, and run this again"
fi

rm -rf "/Applications/GS Distributor.app"
ditto "$APP" "/Applications/GS Distributor.app"
log "Installed /Applications/GS Distributor.app"
