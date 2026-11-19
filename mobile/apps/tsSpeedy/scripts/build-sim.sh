#!/usr/bin/env bash
# Builds for an iPhone simulator and, with INSTALL=1, installs it there. The simulator has no
# Bluetooth, so the radar reads "Bluetooth off"; the readout and the voice work.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
client_xcconfig
[ -d "$SPEEDY_PROJECT" ] || fail "run 'npm run bootstrap' first"

CONFIGURATION="${CONFIGURATION:-Debug}"
LOG="$SPEEDY_DERIVED_DATA/build-sim.log"
mkdir -p "$SPEEDY_DERIVED_DATA"

SIM_UDID="$(resolve_simulator_udid)"
log "Building $SPEEDY_SCHEME for simulator $SIM_UDID"

set +e
xcodebuild build \
  -project "$SPEEDY_PROJECT" \
  -scheme "$SPEEDY_SCHEME" \
  -xcconfig "$CLIENT_XCCONFIG" \
  -configuration "$CONFIGURATION" \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -derivedDataPath "$SPEEDY_DERIVED_DATA" \
  > "$LOG" 2>&1
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  grep -E "(error:|BUILD FAILED)" "$LOG" | head -40 || true
  fail "simulator build failed — full log at $LOG"
fi

APP="$SPEEDY_DERIVED_DATA/Build/Products/$CONFIGURATION-iphonesimulator/TS Speedy.app"
if [ "${INSTALL:-0}" = "1" ]; then
  xcrun simctl install "$SIM_UDID" "$APP"
  log "Installed on simulator $SIM_UDID"
fi
log "Built $APP"
