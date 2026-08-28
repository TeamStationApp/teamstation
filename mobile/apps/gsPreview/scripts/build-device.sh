#!/usr/bin/env bash
# Builds and installs on the connected iPhone 13 Pro.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
require xcrun
[ -d "$PREVIEW_PROJECT" ] || fail "run 'socket npm run bootstrap' first"

CONFIGURATION="${CONFIGURATION:-Debug}"
LOG="$PREVIEW_DERIVED_DATA/build-device.log"
mkdir -p "$PREVIEW_DERIVED_DATA"

DEVICE_READY=1
if ! xcrun devicectl device info details --device "$PREVIEW_DEVICE_UDID" >/dev/null 2>&1; then
  DEVICE_READY=0
fi

if [ "$DEVICE_READY" = "1" ]; then
  log "Building $PREVIEW_SCHEME for iPhone 13 Pro $PREVIEW_DEVICE_UDID"
  DESTINATION="id=$PREVIEW_DEVICE_UDID"
else
  warn "device $PREVIEW_DEVICE_UDID not connected — compiling only, no install"
  DESTINATION="generic/platform=iOS"
fi

build() {
  set +e
  xcodebuild build \
    -project "$PREVIEW_PROJECT" \
    -scheme "$PREVIEW_SCHEME" \
    -configuration "$CONFIGURATION" \
    -destination "$1" \
    -derivedDataPath "$PREVIEW_DERIVED_DATA" \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$PREVIEW_TEAM_ID" \
    > "$LOG" 2>&1
  local status=$?
  set -e
  return $status
}

STATUS=0
build "$DESTINATION" || STATUS=$?

if [ $STATUS -ne 0 ] && grep -q "Unable to find a device matching" "$LOG"; then
  warn "device rejected the build destination — compiling only"
  DEVICE_READY=0
  STATUS=0
  build "generic/platform=iOS" || STATUS=$?
fi

if [ $STATUS -ne 0 ]; then
  grep -E "(error:|BUILD FAILED)" "$LOG" | head -40 || true
  fail "device build failed — full log at $LOG"
fi

APP="$PREVIEW_DERIVED_DATA/Build/Products/$CONFIGURATION-iphoneos/GS Preview.app"
[ -d "$APP" ] || fail "expected app bundle missing at $APP"

if [ "$DEVICE_READY" != "1" ]; then
  log "Built $APP (not installed — device unavailable)"
  echo "$APP"
  exit 0
fi

log "Installing on iPhone 13 Pro $PREVIEW_DEVICE_UDID"
xcrun devicectl device install app --device "$PREVIEW_DEVICE_UDID" "$APP" >/dev/null

if [ "${LAUNCH:-1}" = "1" ]; then
  log "Launching GS Preview on iPhone 13 Pro $PREVIEW_DEVICE_UDID"
  ARGS=()
  if [ -n "${PREVIEW_LAUNCH_ARGS:-}" ]; then
    # shellcheck disable=SC2206
    ARGS=($PREVIEW_LAUNCH_ARGS)
  fi
  xcrun devicectl device process launch \
    --device "$PREVIEW_DEVICE_UDID" \
    --terminate-existing \
    ${ARGS[@]+"${ARGS[@]}"} \
    "$PREVIEW_BUNDLE_ID" >/dev/null
fi

log "Installed $APP"
echo "$APP"
