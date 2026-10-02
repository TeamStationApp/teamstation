#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
[ -d "$PREVIEW_PROJECT" ] || fail "run 'socket npm run bootstrap' first"

CONFIGURATION="${CONFIGURATION:-Debug}"
LOG="$PREVIEW_DERIVED_DATA/build-sim.log"
mkdir -p "$PREVIEW_DERIVED_DATA"

SIM_UDID="$(resolve_simulator_udid)"
log "Building $PREVIEW_SCHEME for '$PREVIEW_SIMULATOR' ($SIM_UDID)"

set +e
xcodebuild build \
  -project "$PREVIEW_PROJECT" \
  -scheme "$PREVIEW_SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -derivedDataPath "$PREVIEW_DERIVED_DATA" \
  > "$LOG" 2>&1
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  grep -E "(error:|BUILD FAILED)" "$LOG" | head -40 || true
  fail "simulator build failed — full log at $LOG"
fi

log "Built for simulator"
