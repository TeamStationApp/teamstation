#!/usr/bin/env bash
# Builds an installable .app for an iPad simulator and prints its path for
# `maestro-runner --app-file`.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
client_xcconfig
[ -d "$DIRECTOR_PROJECT" ] || fail "run 'socket npm run bootstrap' first"

CONFIGURATION="${CONFIGURATION:-Debug}"
LOG="$DIRECTOR_DERIVED_DATA/build-sim.log"
mkdir -p "$DIRECTOR_DERIVED_DATA"

SIM_UDID="$(resolve_simulator_udid)"
log "Building $DIRECTOR_SCHEME for simulator $SIM_UDID ($CONFIGURATION)"
set +e
xcodebuild build \
  -project "$DIRECTOR_PROJECT" \
  -scheme "$DIRECTOR_SCHEME" \
  -xcconfig "$CLIENT_XCCONFIG" \
  -configuration "$CONFIGURATION" \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -derivedDataPath "$DIRECTOR_DERIVED_DATA" \
  CODE_SIGNING_ALLOWED="${SIM_SIGNING:-NO}" \
  > "$LOG" 2>&1
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  grep -E "(error:|warning: .*never used|BUILD FAILED)" "$LOG" | head -40 || true
  fail "build failed — full log at $LOG"
fi

APP="$DIRECTOR_DERIVED_DATA/Build/Products/$CONFIGURATION-iphonesimulator/TS Director.app"
[ -d "$APP" ] || fail "expected app bundle missing at $APP"

log "Built $APP"
echo "$APP"
