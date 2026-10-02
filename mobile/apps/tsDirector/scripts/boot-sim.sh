#!/usr/bin/env bash
# Boots the simulator named by DIRECTOR_SIMULATOR_UDID and prints that UDID.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcrun

UDID="$(resolve_simulator_udid)"

STATE="$(xcrun simctl list devices | grep "$UDID" | sed -E 's/.*\((Booted|Shutdown|[A-Za-z ]+)\).*/\1/')"
if [ "$STATE" != "Booted" ]; then
  log "Booting simulator $UDID"
  xcrun simctl boot "$UDID"
  xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
else
  log "simulator $UDID already booted"
fi

echo "$UDID"
