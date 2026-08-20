#!/usr/bin/env bash
# Builds and installs an ad-hoc signed build on the connected iPad, then optionally launches it.
#
# Use this when a run needs the real device: its thermal envelope, its hardware encoders, or the
# network the cameras are actually on.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
require xcrun
[ -d "$PRODUCER_PROJECT" ] || fail "run 'socket npm run bootstrap' first"

CONFIGURATION="${CONFIGURATION:-Debug}"
LOG="$PRODUCER_DERIVED_DATA/build-device.log"
mkdir -p "$PRODUCER_DERIVED_DATA"

# A locked or mid-pairing iPad makes `-destination id=...` unresolvable, which would otherwise stop
# a compile check that needs no device at all. Fall back to a generic destination so code can still
# be verified; only the install step genuinely requires the hardware.
# `devicectl list devices` prints CoreDevice UUIDs, not the hardware UDID this script uses, so
# grepping that listing never matches. Ask about the device directly instead: this fails when it is
# absent, locked or mid-pairing, which is exactly the set of cases that cannot be installed to.
DEVICE_READY=1
if ! timeout 30 xcrun devicectl device info details --device "$PRODUCER_DEVICE_UDID" >/dev/null 2>&1; then
  DEVICE_READY=0
fi

if [ "$DEVICE_READY" = "1" ]; then
  log "Building $PRODUCER_SCHEME for device $PRODUCER_DEVICE_UDID"
  DESTINATION="id=$PRODUCER_DEVICE_UDID"
else
  warn "device $PRODUCER_DEVICE_UDID not connected — compiling only, no install"
  DESTINATION="generic/platform=iOS"
fi

set +e
xcodebuild build \
  -project "$PRODUCER_PROJECT" \
  -scheme "$PRODUCER_SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "$DESTINATION" \
  -derivedDataPath "$PRODUCER_DERIVED_DATA" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$PRODUCER_TEAM_ID" \
  > "$LOG" 2>&1
STATUS=$?
set -e

# A device can answer `devicectl` while Xcode still refuses it — an unlocked-but-untrusted iPad
# reports "pairing is in progress" only at this point. Retry as a plain compile so a code change can
# still be verified; the trust dialog needs a human either way.
if [ $STATUS -ne 0 ] && grep -q "Unable to find a device matching" "$LOG"; then
  warn "device rejected the build destination (locked, untrusted or mid-pairing) — compiling only"
  DEVICE_READY=0
  set +e
  xcodebuild build \
    -project "$PRODUCER_PROJECT" \
    -scheme "$PRODUCER_SCHEME" \
    -configuration "$CONFIGURATION" \
    -destination "generic/platform=iOS" \
    -derivedDataPath "$PRODUCER_DERIVED_DATA" \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$PRODUCER_TEAM_ID" \
    > "$LOG" 2>&1
  STATUS=$?
  set -e
fi

if [ $STATUS -ne 0 ]; then
  grep -E "(error:|BUILD FAILED)" "$LOG" | head -40 || true
  fail "device build failed — full log at $LOG"
fi

APP="$PRODUCER_DERIVED_DATA/Build/Products/$CONFIGURATION-iphoneos/GS Producer.app"
[ -d "$APP" ] || fail "expected app bundle missing at $APP"

if [ "$DEVICE_READY" != "1" ]; then
  log "Built $APP (not installed — device unavailable)"
  echo "$APP"
  exit 0
fi

log "Installing on device"
xcrun devicectl device install app --device "$PRODUCER_DEVICE_UDID" "$APP" >/dev/null

if [ "${LAUNCH:-1}" = "1" ]; then
  log "Launching"
  xcrun devicectl device process launch \
    --device "$PRODUCER_DEVICE_UDID" \
    --terminate-existing \
    "$PRODUCER_BUNDLE_ID" >/dev/null
fi

log "Installed $APP"
echo "$APP"
