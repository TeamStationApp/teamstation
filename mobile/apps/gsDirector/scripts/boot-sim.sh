#!/usr/bin/env bash
# Boots the default iPad simulator and prints its UDID.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcrun

UDID="$(resolve_simulator_udid)"

STATE="$(xcrun simctl list devices | grep "$UDID" | sed -E 's/.*\((Booted|Shutdown|[A-Za-z ]+)\).*/\1/')"
if [ "$STATE" != "Booted" ]; then
  log "Booting $DIRECTOR_SIMULATOR ($UDID)"
  xcrun simctl boot "$UDID"
  xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
else
  log "$DIRECTOR_SIMULATOR already booted"
fi

echo "$UDID"
