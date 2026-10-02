#!/usr/bin/env bash
# Device-side driving: launch with test arguments, find the app's control-server address, and
# forward control commands.
#
#   scripts/device.sh launch [args...]     launch with -uiTest true and any extra arguments
#   scripts/device.sh address              print http://<ipad>:8765
#   scripts/device.sh get <path>           issue one control command, print the response
#   scripts/device.sh log [seconds]        stream the app's console output
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcrun
require_device_udid >/dev/null

COMMAND="${1:-}"
shift || true

# The app publishes its reachable addresses in its state dump, but the first command has to
# find it without the app's help. The USB link carries a Bonjour `.local` name that works even
# when the iPad is off Wi-Fi, so candidates are probed in that order and the first that answers
# /health wins.
device_address() {
  if [ -n "${DIRECTOR_DEVICE_ADDRESS:-}" ]; then
    echo "$DIRECTOR_DEVICE_ADDRESS"
    return 0
  fi

  local json candidates host
  json="$(mktemp)"
  xcrun devicectl list devices --json-output "$json" >/dev/null 2>&1 || true
  candidates="$(node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const wanted = process.argv[2];
    const device = data.result.devices.find((entry) => entry.hardwareProperties.udid === wanted);
    if (!device) process.exit(0);
    const hosts = new Set();
    const name = (device.deviceProperties.name ?? "").replace(/[^A-Za-z0-9]+/g, "-");
    if (name) hosts.add(`${name}.local`);
    for (const host of device.connectionProperties.potentialHostnames ?? []) hosts.add(host);
    process.stdout.write([ ...hosts ].join("\n"));
  ' "$json" "$DIRECTOR_DEVICE_UDID")"
  rm -f "$json"

  for host in $candidates; do
    if curl -s -m 3 -o /dev/null "http://$host:8765/health"; then
      echo "$host"
      return 0
    fi
  done
  fail "no candidate address answered on port 8765 — is the app running with -uiTest true?"
}

case "$COMMAND" in
  launch)
    xcrun devicectl device process launch \
      --device "$DIRECTOR_DEVICE_UDID" \
      --terminate-existing \
      -- "$DIRECTOR_BUNDLE_ID" \
      -uiTest true "$@" >/dev/null
    log "Launched $DIRECTOR_BUNDLE_ID with -uiTest true $*"
    ;;
  address)
    echo "http://$(device_address):8765"
    ;;
  get)
    TARGET="${1:?usage: device.sh get <path>}"
    curl -sS -m "${DIRECTOR_CONTROL_TIMEOUT:-10}" "http://$(device_address):8765${TARGET}"
    echo
    ;;
  log)
    SECONDS_TO_STREAM="${1:-20}"
    xcrun devicectl device process launch \
      --device "$DIRECTOR_DEVICE_UDID" \
      --terminate-existing \
      --console \
      "$DIRECTOR_BUNDLE_ID" -uiTest true &
    CONSOLE_PID=$!
    sleep "$SECONDS_TO_STREAM"
    kill "$CONSOLE_PID" 2>/dev/null || true
    ;;
  *)
    fail "usage: device.sh {launch|address|get|log}"
    ;;
esac
