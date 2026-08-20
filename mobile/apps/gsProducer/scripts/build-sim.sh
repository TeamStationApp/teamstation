#!/usr/bin/env bash
# Builds an installable .app for an iPad simulator and prints its path for
# `maestro-runner --app-file`.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
[ -d "$PRODUCER_PROJECT" ] || fail "run 'socket npm run bootstrap' first"

CONFIGURATION="${CONFIGURATION:-Debug}"
LOG="$PRODUCER_DERIVED_DATA/build-sim.log"
mkdir -p "$PRODUCER_DERIVED_DATA"

SIM_UDID="$(resolve_simulator_udid)"
log "Building $PRODUCER_SCHEME for '$PRODUCER_SIMULATOR' ($SIM_UDID, $CONFIGURATION)"
set +e
xcodebuild build \
  -project "$PRODUCER_PROJECT" \
  -scheme "$PRODUCER_SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -derivedDataPath "$PRODUCER_DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  > "$LOG" 2>&1
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  grep -E "(error:|warning: .*never used|BUILD FAILED)" "$LOG" | head -40 || true
  fail "build failed — full log at $LOG"
fi

APP="$PRODUCER_DERIVED_DATA/Build/Products/$CONFIGURATION-iphonesimulator/GS Producer.app"
[ -d "$APP" ] || fail "expected app bundle missing at $APP"

log "Built $APP"
echo "$APP"
