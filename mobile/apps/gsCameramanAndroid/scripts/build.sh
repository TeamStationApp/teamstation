#!/usr/bin/env bash
# Builds the debug APK.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$CAMERAMAN_ROOT"
log "Building"
./gradlew :app:assembleDebug --console=plain -q
log "APK at app/build/outputs/apk/debug/app-debug.apk"
