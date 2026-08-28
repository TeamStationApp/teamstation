#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
[ -d "$PREVIEW_PROJECT" ] || fail "run 'socket npm run bootstrap' first"

if command -v xcodegen > /dev/null 2>&1; then
  (cd "$PREVIEW_ROOT" && xcodegen generate --quiet)
fi

LOG="$PREVIEW_DERIVED_DATA/test-unit.log"
mkdir -p "$PREVIEW_DERIVED_DATA"
rm -rf "$PREVIEW_DERIVED_DATA/TestResults.xcresult"

SIM_UDID="$(resolve_simulator_udid)"
log "Testing on '$PREVIEW_SIMULATOR' ($SIM_UDID)"
set +e
xcodebuild test \
  -project "$PREVIEW_PROJECT" \
  -scheme "$PREVIEW_SCHEME" \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -derivedDataPath "$PREVIEW_DERIVED_DATA" \
  -resultBundlePath "$PREVIEW_DERIVED_DATA/TestResults.xcresult" \
  ${ONLY:+-only-testing:"$ONLY"} \
  > "$LOG" 2>&1
STATUS=$?
set -e

grep -E "(Test Suite|Test Case '.*' (passed|failed)|^.*(Suite|Test) .* (passed|failed) after|error:|\*\* TEST)" "$LOG" \
  | grep -vE "^.*Test .* (passed|failed) after .* seconds\.$" \
  | tail -60 || true

CASES="$(xcrun xcresulttool get test-results summary \
  --path "$PREVIEW_DERIVED_DATA/TestResults.xcresult" 2>/dev/null \
  | node -e '
    let raw = ""
    process.stdin.on("data", chunk => (raw += chunk)).on("end", () => {
      try { process.stdout.write(String(JSON.parse(raw).totalTestCount ?? 0)) }
      catch { process.stdout.write("0") }
    })
  ' || true)"
log "Ran ${CASES:-0} test cases"

[ $STATUS -eq 0 ] || fail "tests failed — full log at $LOG"
[ "${CASES:-0}" -gt 0 ] || fail "no test cases ran — full log at $LOG"
log "Tests passed"
