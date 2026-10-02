#!/usr/bin/env bash
# Builds and installs on the connected iPhone, then optionally launches it.
#
# The real device is the only place this app can be verified: the simulator has no camera and no
# hardware encoder worth measuring.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
require xcrun
[ -d "$CAMERAMAN_PROJECT" ] || fail "run 'socket npm run bootstrap' first"

CONFIGURATION="${CONFIGURATION:-Debug}"
LOG="$CAMERAMAN_DERIVED_DATA/build-device.log"
mkdir -p "$CAMERAMAN_DERIVED_DATA"

# A locked or mid-pairing iPhone makes `-destination id=...` unresolvable, which would otherwise
# stop a compile check that needs no device at all. `devicectl list devices` prints CoreDevice
# UUIDs rather than the hardware UDID used here, so ask about the device directly instead.
DEVICE_READY=1
if command -v timeout >/dev/null 2>&1; then
  if ! timeout 30 xcrun devicectl device info details --device "$CAMERAMAN_DEVICE_UDID" >/dev/null 2>&1; then
    DEVICE_READY=0
  fi
elif ! xcrun devicectl device info details --device "$CAMERAMAN_DEVICE_UDID" >/dev/null 2>&1; then
  DEVICE_READY=0
fi

if [ "$DEVICE_READY" = "1" ]; then
  log "Building $CAMERAMAN_SCHEME for device $CAMERAMAN_DEVICE_UDID"
  DESTINATION="id=$CAMERAMAN_DEVICE_UDID"
else
  warn "device $CAMERAMAN_DEVICE_UDID not connected — compiling only, no install"
  DESTINATION="generic/platform=iOS"
fi

build() {
  set +e
  xcodebuild build \
    -project "$CAMERAMAN_PROJECT" \
    -scheme "$CAMERAMAN_SCHEME" \
    -configuration "$CONFIGURATION" \
    -destination "$1" \
    -derivedDataPath "$CAMERAMAN_DERIVED_DATA" \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$CAMERAMAN_TEAM_ID" \
    > "$LOG" 2>&1
  local status=$?
  set -e
  return $status
}

STATUS=0
build "$DESTINATION" || STATUS=$?

# A device can answer `devicectl` while Xcode still refuses it — an unlocked-but-untrusted phone
# reports "pairing is in progress" only at this point. Retry as a plain compile so a code change can
# still be verified; the trust dialog needs a human either way.
if [ $STATUS -ne 0 ] && grep -q "Unable to find a device matching" "$LOG"; then
  warn "device rejected the build destination (locked, untrusted or mid-pairing) — compiling only"
  DEVICE_READY=0
  STATUS=0
  build "generic/platform=iOS" || STATUS=$?
fi

if [ $STATUS -ne 0 ]; then
  grep -E "(error:|BUILD FAILED)" "$LOG" | head -40 || true
  fail "device build failed — full log at $LOG"
fi

APP="$CAMERAMAN_DERIVED_DATA/Build/Products/$CONFIGURATION-iphoneos/TS Cameraman.app"
[ -d "$APP" ] || fail "expected app bundle missing at $APP"

if [ "$DEVICE_READY" != "1" ]; then
  log "Built $APP (not installed — device unavailable)"
  echo "$APP"
  exit 0
fi

log "Installing on device"
xcrun devicectl device install app --device "$CAMERAMAN_DEVICE_UDID" "$APP" >/dev/null

if [ "${LAUNCH:-1}" = "1" ]; then
  log "Launching"
  xcrun devicectl device process launch \
    --device "$CAMERAMAN_DEVICE_UDID" \
    --terminate-existing \
    "$CAMERAMAN_BUNDLE_ID" >/dev/null
fi

log "Installed $APP"
echo "$APP"
