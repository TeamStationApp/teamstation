#!/usr/bin/env bash
# Runs PhoneStream's unit tests on an iPhone simulator, inside the test host in Tests/Host.
#
#   PHONESTREAM_SIMULATOR_UDID=<udid> [COVERAGE=1] [ONLY=PhoneStreamTests/<Suite>] \
#     [PHONESTREAM_SCRATCH=<directory>] ./scripts/test-unit.sh
#
# The encoders need VideoToolbox on iOS, so the package is tested on a simulator rather than with
# `swift test` on the Mac. With COVERAGE=1 the run gathers coverage and then holds every changed
# line of the package to 90% with scripts/swift-changed-line-coverage.cjs. A run that tests nothing
# fails.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="$ROOT/Tests/Host"
PROJECT="$HOST/PhoneStreamHost.xcodeproj"
SCHEME="PhoneStreamHost"
DERIVED_DATA="${PHONESTREAM_DERIVED_DATA:-$ROOT/DerivedData}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
command -v xcodebuild > /dev/null 2>&1 || fail "xcodebuild is required"
command -v xcodegen > /dev/null 2>&1 || fail "xcodegen is required (brew install xcodegen)"

# The simulator is always named by UDID: the same device name exists under several runtimes, and
# the tests never boot or pick one on their own.
SIM_UDID="${PHONESTREAM_SIMULATOR_UDID:-}"
[ -n "$SIM_UDID" ] || fail "set PHONESTREAM_SIMULATOR_UDID to the simulator to test on"

# The project lists test files individually, so it is regenerated every run: a new test file would
# otherwise compile into nothing and the run would pass without it.
(cd "$HOST" && xcodegen generate --quiet)

ARGS=()
if [ -n "${ONLY:-}" ]; then
  ARGS+=(-only-testing:"$ONLY")
fi
# The engine tests write their recordings under PHONESTREAM_SCRATCH when it is set, rather than in
# the simulator's own storage; xcodebuild hands TEST_RUNNER_ variables to the host without the prefix.
if [ -n "${PHONESTREAM_SCRATCH:-}" ]; then
  mkdir -p "$PHONESTREAM_SCRATCH"
  export TEST_RUNNER_PHONESTREAM_SCRATCH="$PHONESTREAM_SCRATCH"
fi
COVERAGE="${COVERAGE:-}"
if [ -n "$COVERAGE" ]; then
  ARGS+=(-enableCodeCoverage YES)
fi

mkdir -p "$DERIVED_DATA"
LOG="$DERIVED_DATA/test-unit.log"
RESULT="$DERIVED_DATA/TestResults.xcresult"
# xcodebuild refuses to overwrite a result bundle.
rm -rf "$RESULT"

# A host already installed can outlive a rebuild: the simulator has been seen running the test
# bundle a previous build installed. Removing it first makes the run test what was just built.
xcrun simctl uninstall "$SIM_UDID" app.teamstation.phonestreamhost > /dev/null 2>&1 || true

log "Testing on simulator $SIM_UDID"
# A simulator that has just had the host installed sometimes refuses its first launch ("failed
# preflight checks", Busy). That is the simulator, not the tests, so the run is made once more.
for ATTEMPT in 1 2; do
  rm -rf "$RESULT"
  set +e
  xcodebuild test \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -destination "platform=iOS Simulator,id=$SIM_UDID" \
    -derivedDataPath "$DERIVED_DATA" \
    -resultBundlePath "$RESULT" \
    CODE_SIGNING_ALLOWED=NO \
    ${ARGS[@]+"${ARGS[@]}"} \
    > "$LOG" 2>&1
  STATUS=$?
  set -e
  if [ $STATUS -ne 0 ] && grep -q "failed preflight checks" "$LOG"; then
    log "The simulator refused the launch; trying once more"
    continue
  fi
  break
done

# Swift Testing reports through "Suite"/"Test" lines, XCTest through "Test Suite"/"Test Case".
grep -E "(Test Suite|Test Case '.*' (passed|failed)|^.*(Suite|Test) .* (passed|failed) after|error:|\*\* TEST)" "$LOG" \
  | grep -vE "^.*Test .* passed after .* seconds\.$" \
  | tail -60 || true

# A run that tests nothing exits zero, which is the failure most likely to go unnoticed.
CASES="$(xcrun xcresulttool get test-results summary --path "$RESULT" 2>/dev/null \
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
  TOP="$(git -C "$ROOT" rev-parse --show-toplevel)"
  log "Changed-line coverage"
  (
    cd "$TOP"
    # Every changed line of the package, the system wiring included: the tests build the app's
    # own environment and post the application's notifications.
    node "$TOP/scripts/swift-changed-line-coverage.cjs" \
      --xcresult "$RESULT" \
      --derived-data "$DERIVED_DATA" \
      mobile/apps/common/PhoneStream
  ) || COVERED=1
fi

[ $STATUS -eq 0 ] || fail "tests failed — full log at $LOG"
[ "${CASES:-0}" -gt 0 ] || fail "no test cases ran — full log at $LOG"
[ $COVERED -eq 0 ] || fail "changed lines are under 90% covered"
log "Tests passed"
