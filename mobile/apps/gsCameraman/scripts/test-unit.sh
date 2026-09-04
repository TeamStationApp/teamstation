#!/usr/bin/env bash
# Runs the unit test target on an iPhone simulator.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
[ -d "$CAMERAMAN_PROJECT" ] || fail "run 'socket npm run bootstrap' first"

# The project lists test files individually, so a newly added test file compiles into nothing and
# the run passes without it. Regenerating first is cheaper than that silence.
if command -v xcodegen > /dev/null 2>&1; then
  (cd "$CAMERAMAN_ROOT" && xcodegen generate --quiet)
fi

ONLY="${ONLY:-}"
ARGS=()
if [ -n "$ONLY" ]; then
  ARGS+=(-only-testing:"$ONLY")
fi

LOG="$CAMERAMAN_DERIVED_DATA/test-unit.log"
mkdir -p "$CAMERAMAN_DERIVED_DATA"

# xcodebuild refuses to overwrite an existing result bundle, so a second run of this script would
# fail before testing anything.
rm -rf "$CAMERAMAN_DERIVED_DATA/TestResults.xcresult"

SIM_UDID="$(resolve_simulator_udid)"
log "Testing on '$CAMERAMAN_SIMULATOR' ($SIM_UDID)"
set +e
xcodebuild test \
  -project "$CAMERAMAN_PROJECT" \
  -scheme "$CAMERAMAN_SCHEME" \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -derivedDataPath "$CAMERAMAN_DERIVED_DATA" \
  -resultBundlePath "$CAMERAMAN_DERIVED_DATA/TestResults.xcresult" \
  ${ARGS[@]+"${ARGS[@]}"} \
  > "$LOG" 2>&1
STATUS=$?
set -e

rm -rf "$CAMERAMAN_DERIVED_DATA/TestResults.xcresult.previous"

# Swift Testing reports through "Suite"/"Test" lines rather than XCTest's "Test Suite"/"Test Case",
# so both vocabularies have to be matched or half the suite looks like it never ran.
grep -E "(Test Suite|Test Case '.*' (passed|failed)|^.*(Suite|Test) .* (passed|failed) after|error:|\*\* TEST)" "$LOG" \
  | grep -vE "^.*Test .* (passed|failed) after .* seconds\.$" \
  | tail -60 || true

# A run that tests nothing exits zero, which is the failure mode most likely to go unnoticed here.
CASES="$(xcrun xcresulttool get test-results summary \
  --path "$CAMERAMAN_DERIVED_DATA/TestResults.xcresult" 2>/dev/null \
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

[ $STATUS -eq 0 ] || fail "tests failed — full log at $LOG"
[ "${CASES:-0}" -gt 0 ] || fail "no test cases ran — full log at $LOG"
log "Tests passed"
