#!/usr/bin/env bash
# The JVM suites. No device, no network, no camera.
#
# COVERAGE=1 also writes the debug variant's JaCoCo XML report with Kover and holds the lines this
# branch changed under the app to 90%, through the repository's changed-line gate.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$CAMERAMAN_ROOT"

if [ -z "${COVERAGE:-}" ]; then
  log "Running unit tests"
  ./gradlew :app:testDebugUnitTest --console=plain
  exit 0
fi

log "Running unit tests with coverage"
./gradlew :app:testDebugUnitTest :app:koverXmlReportDebug --console=plain

TOP="$(git rev-parse --show-toplevel)"
log "Changed-line coverage"
# The GL renderer and the Camera2 session need a device's EGL and camera, and SentryTest's native
# crash needs the device's library; the gate holds the logic they call into. A branch that changed nothing here passes.
node "$TOP/scripts/changed-line-check.cjs" \
  --jacoco "$CAMERAMAN_ROOT/app/build/reports/kover/reportDebug.xml" \
  --source-root "$CAMERAMAN_ROOT/app/src/main/kotlin" \
  --ext .kt \
  --allow-empty \
  --exclude "$CAMERAMAN_ROOT/app/src/main/kotlin/app/teamstation/cameraman/gl" \
  --exclude "$CAMERAMAN_ROOT/app/src/main/kotlin/app/teamstation/cameraman/capture/CameraSession.kt" \
  --exclude "$CAMERAMAN_ROOT/app/src/main/kotlin/app/teamstation/cameraman/sentry/SentryTest.kt" \
  "$CAMERAMAN_ROOT/app/src/main" \
  || fail "changed lines are under 90% covered"
log "Tests passed"
