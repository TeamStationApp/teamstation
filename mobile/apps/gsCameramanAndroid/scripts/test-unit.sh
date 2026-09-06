#!/usr/bin/env bash
# The JVM suites. No device, no network, no camera.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$CAMERAMAN_ROOT"
log "Running unit tests"
./gradlew :app:testDebugUnitTest --console=plain
