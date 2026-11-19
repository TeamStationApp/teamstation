#!/usr/bin/env bash
# Runs the unit tests on an iPhone simulator. With COVERAGE=1, also checks that the lines this
# branch changed are at least 90% covered; COVERAGE_BASE names the commit to compare against
# (default: where the branch left origin/develop).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
client_xcconfig
[ -d "$SPEEDY_PROJECT" ] || fail "run 'npm run bootstrap' first"

# The project lists test files individually, so a newly added test file compiles into nothing and
# the run passes without it. Regenerating first is cheaper than that silence.
if command -v xcodegen > /dev/null 2>&1; then
  (cd "$SPEEDY_ROOT" && xcodegen generate --quiet)
fi

ONLY="${ONLY:-}"
ARGS=()
if [ -n "$ONLY" ]; then
  ARGS+=(-only-testing:"$ONLY")
fi
COVERAGE="${COVERAGE:-}"
if [ -n "$COVERAGE" ]; then
  ARGS+=(-enableCodeCoverage YES)
fi

LOG="$SPEEDY_DERIVED_DATA/test-unit.log"
mkdir -p "$SPEEDY_DERIVED_DATA"
rm -rf "$SPEEDY_DERIVED_DATA/TestResults.xcresult"

SIM_UDID="$(resolve_simulator_udid)"
log "Testing on simulator $SIM_UDID"
set +e
xcodebuild test \
  -project "$SPEEDY_PROJECT" \
  -scheme "$SPEEDY_SCHEME" \
  -xcconfig "$CLIENT_XCCONFIG" \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -derivedDataPath "$SPEEDY_DERIVED_DATA" \
  -resultBundlePath "$SPEEDY_DERIVED_DATA/TestResults.xcresult" \
  ${ARGS[@]+"${ARGS[@]}"} \
  > "$LOG" 2>&1
STATUS=$?
set -e

# Swift Testing reports through "Suite"/"Test" lines rather than XCTest's, so match both.
grep -E "(Test Suite|Test Case '.*' (passed|failed)|^.*(Suite|Test) .* (passed|failed) after|error:|\*\* TEST)" "$LOG" \
  | grep -vE "^.*Test .* (passed|failed) after .* seconds\.$" \
  | tail -60 || true

# A run that tests nothing exits zero, which is the failure most likely to go unnoticed.
CASES="$(xcrun xcresulttool get test-results summary \
  --path "$SPEEDY_DERIVED_DATA/TestResults.xcresult" 2>/dev/null \
  | node -e '
    let raw = ""
    process.stdin.on("data", chunk => (raw += chunk)).on("end", () => {
      try {
        process.stdout.write(String(JSON.parse(raw).totalTestCount ?? 0))
      } catch {
        process.stdout.write("0")
      }
    })
  ' || true)"
log "Ran ${CASES:-0} test cases"

COVERED=0
if [ -n "$COVERAGE" ]; then
  TOP="$(git -C "$SPEEDY_ROOT" rev-parse --show-toplevel)"
  BASE="${COVERAGE_BASE:-$(git -C "$TOP" merge-base origin/develop HEAD)}"
  log "Changed-line coverage against $BASE"
  (
    cd "$TOP"
    # Every changed line of the app's logic: SpeedyCore, the voice package, and the app's radar,
    # player and launch code. ReadoutView, SettingsView and SpeedyApp's scene are SwiftUI layout;
    # the decisions they show are made in SpeedyCore and measured there. SpeedyRadar.swift only
    # declares protocols, so it has no executable lines to record.
    node "$TOP/scripts/swift-changed-line-coverage.cjs" \
      --xcresult "$SPEEDY_DERIVED_DATA/TestResults.xcresult" \
      --derived-data "$SPEEDY_DERIVED_DATA" \
      --base "$BASE" \
      --exclude mobile/apps/tsSpeedy/App/ReadoutView.swift \
      --exclude mobile/apps/tsSpeedy/App/SettingsView.swift \
      --exclude mobile/apps/tsSpeedy/App/SpeedyApp.swift \
      --exclude mobile/apps/tsSpeedy/Packages/SpeedyCore/Sources/SpeedyCore/SpeedyRadar.swift \
      mobile/apps/tsSpeedy/Packages/SpeedyCore \
      mobile/apps/tsSpeedy/App \
      mobile/apps/common/SpeedyVoice
  ) || COVERED=1
fi

[ $STATUS -eq 0 ] || fail "tests failed — full log at $LOG"
[ "${CASES:-0}" -gt 0 ] || fail "no test cases ran — full log at $LOG"
[ $COVERED -eq 0 ] || fail "changed lines are under 90% covered"
log "Tests passed"
