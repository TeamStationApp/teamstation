#!/usr/bin/env bash
# The app's JVM suites under Robolectric. No device, no radar.
#
# COVERAGE=1 also writes Kover's debug JaCoCo report, holds the whole app to 90% (koverVerify), and
# holds the lines this branch changed to 90% through the repository's changed-line gate.
# COVERAGE_BASE names the commit to compare against (default: where the branch left origin/develop).
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$SPEEDY_ROOT"

if [ -z "${COVERAGE:-}" ]; then
  log "Running unit tests"
  ./gradlew :app:testDebugUnitTest --console=plain
  exit 0
fi

log "Running unit tests with coverage"
./gradlew :app:testDebugUnitTest :app:koverXmlReportDebug :app:koverVerify --console=plain

TOP="$(git rev-parse --show-toplevel)"
BASE="${COVERAGE_BASE:-$(git merge-base origin/develop HEAD)}"
log "Changed-line coverage against $BASE"
# SpeedyRadar.kt only declares interfaces, so it has no executable lines to record.
node "$TOP/scripts/changed-line-check.cjs" \
  --jacoco "$SPEEDY_ROOT/app/build/reports/kover/reportDebug.xml" \
  --source-root "$SPEEDY_ROOT/app/src/main/kotlin" \
  --ext .kt \
  --base "$BASE" \
  --allow-empty \
  --exclude "$SPEEDY_ROOT/app/src/main/kotlin/app/teamstation/speedy/core/SpeedyRadar.kt" \
  "$SPEEDY_ROOT/app/src/main" \
  || fail "changed lines in the app are under 90% covered"
log "Tests passed"
