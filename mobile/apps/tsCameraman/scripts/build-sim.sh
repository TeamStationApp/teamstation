#!/usr/bin/env bash
# Builds for an iPhone simulator. A compile check and a home for the pure-logic tests; the camera
# and the RTSP server both need real hardware.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
[ -d "$CAMERAMAN_PROJECT" ] || fail "run 'socket npm run bootstrap' first"

CONFIGURATION="${CONFIGURATION:-Debug}"
LOG="$CAMERAMAN_DERIVED_DATA/build-sim.log"
mkdir -p "$CAMERAMAN_DERIVED_DATA"

SIM_UDID="$(resolve_simulator_udid)"
log "Building $CAMERAMAN_SCHEME for '$CAMERAMAN_SIMULATOR' ($SIM_UDID)"

set +e
xcodebuild build \
  -project "$CAMERAMAN_PROJECT" \
  -scheme "$CAMERAMAN_SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -derivedDataPath "$CAMERAMAN_DERIVED_DATA" \
  > "$LOG" 2>&1
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  grep -E "(error:|BUILD FAILED)" "$LOG" | head -40 || true
  fail "simulator build failed — full log at $LOG"
fi

log "Built for simulator"
