#!/usr/bin/env bash
# Drives the client-connect flow: runs it against the device while a real RTSP client connects and
# then leaves, so the on-screen client count is checked against something that actually happened.
#
# The flow cannot start the client itself — Maestro's runScript has no process access — so the two
# are coordinated here: the flow goes first and waits, this script connects once the app is up.
#
#   bash scripts/verifyClientCount.sh [seconds]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

STREAM_SECONDS="${1:-10}"
SETTLE_SECONDS="${SETTLE_SECONDS:-22}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }

log "Building and installing"
LAUNCH=0 bash "$CAMERAMAN_ROOT/scripts/build-device.sh" >/dev/null

log "Starting the flow, which will launch the app and wait for a client"
node "$CAMERAMAN_ROOT/scripts/run-maestro.js" client-connect &
FLOW_PID=$!

# The flow reinstalls and relaunches the app, so connecting before that has settled would land on the
# listener that is about to be torn down and the count would drop back to zero on its own.
log "Waiting ${SETTLE_SECONDS}s for the relaunched app to be listening"
sleep "$SETTLE_SECONDS"

HOST="$(node "$CAMERAMAN_ROOT/scripts/resolveCamera.js" | tail -1)"
if [ -z "$HOST" ]; then
  echo "could not find the camera over Bonjour" >&2
  kill "$FLOW_PID" 2>/dev/null || true
  exit 1
fi

log "Streaming ${STREAM_SECONDS}s from $HOST"
node "$CAMERAMAN_ROOT/scripts/rtspClient.js" --host "$HOST" --seconds "$STREAM_SECONDS" >/dev/null

log "Client gone; waiting for the flow to confirm the count came back down"
wait "$FLOW_PID"
