#!/usr/bin/env bash
# Launches the app with launch arguments.
#
#   bash scripts/launch.sh                       # plain
#   bash scripts/launch.sh uiTest true codec hevc
#
# Keys are the iOS build's keys; only the channel differs, because `am start --es` is the only way
# a launcher can pass anything to an Android activity.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require adb

DEVICE="$(resolveDevice)"
EXTRAS=()
while [ $# -gt 1 ]; do
  EXTRAS+=(--es "$1" "$2")
  shift 2
done
[ $# -eq 0 ] || fail "launch arguments must be key/value pairs"

adb -s "$DEVICE" shell am force-stop "$CAMERAMAN_PACKAGE"
log "Launching ${EXTRAS[*]+${EXTRAS[*]}}"
# Guarded: with no arguments the array is empty, and bash 3 under `set -u` calls an empty array
# unbound, which stopped a plain launch before the app ever started.
adb -s "$DEVICE" shell am start -n "$CAMERAMAN_ACTIVITY" ${EXTRAS[@]+"${EXTRAS[@]}"} >/dev/null
