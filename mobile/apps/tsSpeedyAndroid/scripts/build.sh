#!/usr/bin/env bash
# Builds the debug APK and, with SPEEDY_ANDROID_SERIAL set, installs it on that phone.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$SPEEDY_ROOT"
log "Building"
./gradlew :app:assembleDebug --console=plain -q
APK="$SPEEDY_ROOT/app/build/outputs/apk/debug/app-debug.apk"
if [ -n "${SPEEDY_ANDROID_SERIAL:-}" ]; then
  adb -s "$SPEEDY_ANDROID_SERIAL" install -r "$APK" >/dev/null
  log "Installed on $SPEEDY_ANDROID_SERIAL"
fi
log "APK at $APK"
