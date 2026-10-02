#!/usr/bin/env bash
# Runs the unit and integration test targets on an iPad simulator.
#
# COVERAGE=1 also gathers code coverage and holds the lines this branch changed in TS Director,
# DirectorCore and DirectorExport to 90% with scripts/swift-changed-line-coverage.cjs. The files it
# excludes are SwiftUI layout and AppEnvironment's one-line wiring, which the maestro-d device tests
# exercise instead; the package manifests and the Mac tools under tools/, which no iPad test bundle
# compiles, so they never have a coverage record.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodebuild
[ -d "$DIRECTOR_PROJECT" ] || fail "run 'socket npm run bootstrap' first"

# The project lists test files individually, so a newly added test file compiles into nothing and
# the run passes without it. Regenerating first is cheaper than that silence.
if command -v xcodegen > /dev/null 2>&1; then
  xcodegen generate --quiet
fi

ONLY="${ONLY:-}"
# Expanded as `${ARGS[@]+"${ARGS[@]}"}` below: bash 3.2, which is what /bin/bash is on macOS,
# treats an empty array as unset under `set -u`, so a plain `"${ARGS[@]}"` aborts the whole run
# with "unbound variable" whenever ONLY is not given — that is, on every full test run.
ARGS=()
if [ -n "$ONLY" ]; then
  ARGS+=(-only-testing:"$ONLY")
fi
COVERAGE="${COVERAGE:-}"
if [ -n "$COVERAGE" ]; then
  ARGS+=(-enableCodeCoverage YES)
fi

LOG="$DIRECTOR_DERIVED_DATA/test-unit.log"
mkdir -p "$DIRECTOR_DERIVED_DATA"

# xcodebuild refuses to overwrite an existing result bundle, so a second run of this script would
# fail before testing anything.
rm -rf "$DIRECTOR_DERIVED_DATA/TestResults.xcresult"

SIM_UDID="$(resolve_simulator_udid)"
log "Testing on simulator $SIM_UDID"
set +e
xcodebuild test \
  -project "$DIRECTOR_PROJECT" \
  -scheme "$DIRECTOR_SCHEME" \
  -destination "platform=iOS Simulator,id=$SIM_UDID" \
  -derivedDataPath "$DIRECTOR_DERIVED_DATA" \
  -resultBundlePath "$DIRECTOR_DERIVED_DATA/TestResults.xcresult" \
  ${ARGS[@]+"${ARGS[@]}"} \
  > "$LOG" 2>&1
STATUS=$?
set -e

rm -rf "$DIRECTOR_DERIVED_DATA/TestResults.xcresult.previous"

# Swift Testing reports through "Suite"/"Test" lines rather than XCTest's "Test Suite"/"Test Case",
# so both vocabularies have to be matched or half the suite looks like it never ran.
grep -E "(Test Suite|Test Case '.*' (passed|failed)|^.*(Suite|Test) .* (passed|failed) after|error:|\*\* TEST)" "$LOG" \
  | grep -vE "^.*Test .* (passed|failed) after .* seconds\.$" \
  | tail -60 || true

# A run that tests nothing exits zero, which is the failure mode most likely to go unnoticed here.
#
# The count comes from the result bundle rather than the log. Counting log lines drifts — suites,
# parameterised cases and reruns each print one — and it reported 134 and 137 for the same 135 tests,
# which is worse than no number at all when the number exists to prove the suite ran.
CASES="$(xcrun xcresulttool get test-results summary \
  --path "$DIRECTOR_DERIVED_DATA/TestResults.xcresult" 2>/dev/null \
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

# Measured whether or not a test failed, so a run with one failure still reports its coverage.
COVERED=0
if [ -n "$COVERAGE" ]; then
  # From the top level, where the pathspecs below are written.
  TOP="$(git -C "$DIRECTOR_ROOT" rev-parse --show-toplevel)"
  log "Changed-line coverage"
  (
    cd "$TOP"
    node "$TOP/scripts/swift-changed-line-coverage.cjs" \
      --xcresult "$DIRECTOR_DERIVED_DATA/TestResults.xcresult" \
      --derived-data "$DIRECTOR_DERIVED_DATA" \
      --exclude mobile/apps/tsDirector/Packages/DirectorUI/Sources/DirectorUI/SettingsView.swift \
      --exclude mobile/apps/tsDirector/Packages/DirectorUI/Sources/DirectorUI/TeamStationEventPicker.swift \
      --exclude mobile/apps/tsDirector/Packages/DirectorUI/Sources/DirectorUI/TeamStationSignIn.swift \
      --exclude mobile/apps/tsDirector/Packages/DirectorUI/Sources/DirectorUI/ContentEditorView.swift \
      --exclude mobile/apps/tsDirector/Packages/DirectorUI/Sources/DirectorUI/AppEnvironment.swift \
      --exclude mobile/apps/tsDirector/Packages/DirectorUI/Sources/DirectorUI/EventPickerSheet.swift \
      --exclude mobile/apps/tsDirector/Packages/DirectorUI/Sources/DirectorUI/RecordingsView.swift \
      --exclude mobile/apps/tsDirector/Packages/DirectorUI/Sources/DirectorUI/DirectorGridView.swift \
      --exclude '**/Package.swift' \
      --exclude 'mobile/apps/tsDirector/tools/**' \
      mobile/apps/tsDirector mobile/apps/common/DirectorCore mobile/apps/common/DirectorExport
  ) || COVERED=1
fi

[ $STATUS -eq 0 ] || fail "tests failed — full log at $LOG"
[ "${CASES:-0}" -gt 0 ] || fail "no test cases ran — full log at $LOG"
[ $COVERED -eq 0 ] || fail "changed lines are under 90% covered"
log "Tests passed"
