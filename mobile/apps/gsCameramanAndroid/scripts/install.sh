#!/usr/bin/env bash
# Builds, installs and grants the runtime permissions.
#
# The permissions are granted rather than tapped because the system dialogs sit outside the app's
# accessibility hierarchy and a flow cannot see them — the same trap the iOS build documents.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require adb

DEVICE="$(resolveDevice)"
bash "$CAMERAMAN_ROOT/scripts/build.sh"

log "Installing on $DEVICE"
adb -s "$DEVICE" install -r "$CAMERAMAN_ROOT/app/build/outputs/apk/debug/app-debug.apk" >/dev/null

for permission in CAMERA RECORD_AUDIO POST_NOTIFICATIONS; do
  adb -s "$DEVICE" shell pm grant "$CAMERAMAN_PACKAGE" "android.permission.$permission" || true
done
log "Installed and permitted"
