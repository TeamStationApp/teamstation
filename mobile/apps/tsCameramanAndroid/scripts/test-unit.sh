#!/usr/bin/env bash
# The JVM suites of the app and the shared :streamcore library. No device, no network, no camera.
#
# COVERAGE=1 also writes each module's debug JaCoCo XML report with Kover and holds the lines this
# branch changed in each module to 90%, through the repository's changed-line gate.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$CAMERAMAN_ROOT"

if [ -z "${COVERAGE:-}" ]; then
  log "Running unit tests"
  ./gradlew :app:testDebugUnitTest :streamcore:testDebugUnitTest --console=plain
  exit 0
fi

log "Running unit tests with coverage"
./gradlew :app:testDebugUnitTest :streamcore:testDebugUnitTest \
  :app:koverXmlReportDebug :streamcore:koverXmlReportDebug --console=plain

TOP="$(git rev-parse --show-toplevel)"
STREAMCORE_ROOT="$CAMERAMAN_ROOT/../common/android/streamcore"
APP_SOURCES="$CAMERAMAN_ROOT/app/src/main/kotlin/app/teamstation/cameraman"
STREAMCORE_SOURCES="$STREAMCORE_ROOT/src/main/kotlin/app/teamstation/streamcore"

# The GL renderer and the Camera2 session need a device's EGL and camera, and SentryTest's native
# crash needs the device's library; the gate holds the logic they call into. Device event control
# (eventcontrol/, and the scoreboard and settings code it drives) is under app/src/main and held
# like the rest. A branch that changed nothing in a module passes for that module.
log "Changed-line coverage: app"
node "$TOP/scripts/changed-line-check.cjs" \
  --jacoco "$CAMERAMAN_ROOT/app/build/reports/kover/reportDebug.xml" \
  --source-root "$CAMERAMAN_ROOT/app/src/main/kotlin" \
  --ext .kt \
  --allow-empty \
  --exclude "$APP_SOURCES/sentry/SentryTest.kt" \
  "$CAMERAMAN_ROOT/app/src/main" \
  || fail "changed lines in the app are under 90% covered"

log "Changed-line coverage: streamcore"
node "$TOP/scripts/changed-line-check.cjs" \
  --jacoco "$STREAMCORE_ROOT/build/reports/kover/reportDebug.xml" \
  --source-root "$STREAMCORE_ROOT/src/main/kotlin" \
  --ext .kt \
  --allow-empty \
  --exclude "$STREAMCORE_SOURCES/gl" \
  --exclude "$STREAMCORE_SOURCES/capture/CameraSession.kt" \
  "$STREAMCORE_ROOT/src/main" \
  || fail "changed lines in streamcore are under 90% covered"
log "Tests passed"
