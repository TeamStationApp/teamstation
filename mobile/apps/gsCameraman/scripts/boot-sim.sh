#!/usr/bin/env bash
# Boots the iPhone simulator the test scripts target.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcrun
SIM_UDID="$(resolve_simulator_udid)"

if xcrun simctl list devices | grep -q "$SIM_UDID) (Booted)"; then
  log "'$CAMERAMAN_SIMULATOR' already booted"
  exit 0
fi

log "Booting '$CAMERAMAN_SIMULATOR' ($SIM_UDID)"
xcrun simctl boot "$SIM_UDID"
xcrun simctl bootstatus "$SIM_UDID" -b
log "Booted"
