#!/usr/bin/env bash
# Regenerates Distributor.xcodeproj from project.yml and builds GS Distributor.app, printing its path.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodegen
require xcodebuild

cd "$DISTRIBUTOR_ROOT"
xcodegen generate --quiet

CONFIGURATION="${CONFIGURATION:-Debug}"
LOG="$DISTRIBUTOR_DERIVED_DATA/build.log"
mkdir -p "$DISTRIBUTOR_DERIVED_DATA"

log "Building $DISTRIBUTOR_SCHEME ($CONFIGURATION)"
set +e
xcodebuild build \
  -project "$DISTRIBUTOR_PROJECT" \
  -scheme "$DISTRIBUTOR_SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "platform=macOS" \
  -derivedDataPath "$DISTRIBUTOR_DERIVED_DATA" \
  > "$LOG" 2>&1
STATUS=$?
set -e

if [ $STATUS -ne 0 ]; then
  grep -E "(error:|BUILD FAILED)" "$LOG" | head -40 || true
  fail "build failed — full log at $LOG"
fi

APP="$DISTRIBUTOR_DERIVED_DATA/Build/Products/$CONFIGURATION/GS Distributor.app"
[ -d "$APP" ] || fail "expected app bundle missing at $APP"
log "Built $APP"
echo "$APP"
