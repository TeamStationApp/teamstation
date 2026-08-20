#!/usr/bin/env bash
# Shared configuration for the Producer build scripts.
set -euo pipefail

PRODUCER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PRODUCER_ROOT

export PRODUCER_SCHEME="${PRODUCER_SCHEME:-Producer}"
export PRODUCER_PROJECT="$PRODUCER_ROOT/Producer.xcodeproj"
export PRODUCER_DERIVED_DATA="${PRODUCER_DERIVED_DATA:-$PRODUCER_ROOT/DerivedData}"
# D10: closest high-end iPad simulator available on this machine.
export PRODUCER_SIMULATOR="${PRODUCER_SIMULATOR:-iPad Pro 13-inch (M5)}"
# Whichever iPad is plugged in, rather than a name in a script: this project has been measured on
# an A12X and an M4, and the two are not interchangeable in any thermal or throughput reading.
# `PRODUCER_DEVICE_UDID` pins a specific one when both are attached.
resolve_device_udid() {
  xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null \
    | node -e '
      let raw = ""
      process.stdin.on("data", chunk => (raw += chunk)).on("end", () => {
        const data = JSON.parse(raw.slice(raw.indexOf("{")))
        const iPads = data.result.devices.filter(entry =>
          (entry.hardwareProperties.deviceType ?? "") === "iPad" &&
          entry.connectionProperties.tunnelState === "connected"
        )
        const m4 = iPads.find(entry =>
          (entry.hardwareProperties.marketingName ?? "").includes("M4")
        )
        const chosen = m4 ?? iPads[0]
        if (chosen) process.stdout.write(chosen.hardwareProperties.udid)
      })
    ' 2>/dev/null
}

if [ -z "${PRODUCER_DEVICE_UDID:-}" ]; then
  PRODUCER_DEVICE_UDID="$(resolve_device_udid || true)"
  : "${PRODUCER_DEVICE_UDID:=00008132-0000193801B9001C}"
fi
export PRODUCER_DEVICE_UDID
export PRODUCER_BUNDLE_ID="${PRODUCER_BUNDLE_ID:-co.gamestation.producer}"
export PRODUCER_TEAM_ID="${PRODUCER_TEAM_ID:-G5LQ7MERPK}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"
}

# The same simulator name exists under several installed runtimes, which makes a
# name-based -destination ambiguous, so always resolve to a concrete UDID.
resolve_simulator_udid() {
  if [ -n "${PRODUCER_SIMULATOR_UDID:-}" ]; then
    echo "$PRODUCER_SIMULATOR_UDID"
    return 0
  fi
  local udid
  udid="$(xcrun simctl list devices available \
    | grep -F "$PRODUCER_SIMULATOR (" \
    | tail -1 \
    | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/')"
  [ -n "$udid" ] || fail "no available simulator named '$PRODUCER_SIMULATOR'"
  echo "$udid"
}
