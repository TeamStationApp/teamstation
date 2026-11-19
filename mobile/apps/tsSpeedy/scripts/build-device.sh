#!/usr/bin/env bash
# Builds for the iPhone named by SPEEDY_DEVICE_UDID and installs it there.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
require xcrun
client_xcconfig
[ -d "$SPEEDY_PROJECT" ] || fail "run 'npm run bootstrap' first"
[ -n "${SPEEDY_DEVICE_UDID:-}" ] || fail "set SPEEDY_DEVICE_UDID to the iPhone's UDID"

CONFIGURATION="${CONFIGURATION:-Debug}"
LOG="$SPEEDY_DERIVED_DATA/build-device.log"
mkdir -p "$SPEEDY_DERIVED_DATA"

log "Building $SPEEDY_SCHEME for device $SPEEDY_DEVICE_UDID"
set +e
xcodebuild build \
  -project "$SPEEDY_PROJECT" \
  -scheme "$SPEEDY_SCHEME" \
  -xcconfig "$CLIENT_XCCONFIG" \
  -configuration "$CONFIGURATION" \
  -destination "id=$SPEEDY_DEVICE_UDID" \
  -derivedDataPath "$SPEEDY_DERIVED_DATA" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$SPEEDY_TEAM_ID" \
  > "$LOG" 2>&1
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  grep -E "(error:|BUILD FAILED)" "$LOG" | head -40 || true
  fail "device build failed — full log at $LOG"
fi

APP="$SPEEDY_DERIVED_DATA/Build/Products/$CONFIGURATION-iphoneos/TS Speedy.app"
[ -d "$APP" ] || fail "expected app bundle missing at $APP"
log "Installing on device"
xcrun devicectl device install app --device "$SPEEDY_DEVICE_UDID" "$APP" >/dev/null
log "Installed $APP"
