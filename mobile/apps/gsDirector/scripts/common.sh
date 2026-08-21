#!/usr/bin/env bash
# Shared configuration for the Director build scripts.
set -euo pipefail

DIRECTOR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DIRECTOR_ROOT

export DIRECTOR_SCHEME="${DIRECTOR_SCHEME:-Director}"
export DIRECTOR_PROJECT="$DIRECTOR_ROOT/Director.xcodeproj"
export DIRECTOR_DERIVED_DATA="${DIRECTOR_DERIVED_DATA:-$DIRECTOR_ROOT/DerivedData}"
# D10: closest high-end iPad simulator available on this machine.
export DIRECTOR_SIMULATOR="${DIRECTOR_SIMULATOR:-iPad Pro 13-inch (M5)}"
# Whichever iPad is plugged in, rather than a name in a script: this project has been measured on
# an A12X and an M4, and the two are not interchangeable in any thermal or throughput reading.
# `DIRECTOR_DEVICE_UDID` pins a specific one when both are attached.
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

if [ -z "${DIRECTOR_DEVICE_UDID:-}" ]; then
  DIRECTOR_DEVICE_UDID="$(resolve_device_udid || true)"
  : "${DIRECTOR_DEVICE_UDID:=11111111-1111111111111111}"
fi
export DIRECTOR_DEVICE_UDID
export DIRECTOR_BUNDLE_ID="${DIRECTOR_BUNDLE_ID:-co.gamestation.director}"
export DIRECTOR_TEAM_ID="${DIRECTOR_TEAM_ID:-G5LQ7MERPK}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"
}

# The same simulator name exists under several installed runtimes, which makes a
# name-based -destination ambiguous, so always resolve to a concrete UDID.
resolve_simulator_udid() {
  if [ -n "${DIRECTOR_SIMULATOR_UDID:-}" ]; then
    echo "$DIRECTOR_SIMULATOR_UDID"
    return 0
  fi
  local udid
  udid="$(xcrun simctl list devices available \
    | grep -F "$DIRECTOR_SIMULATOR (" \
    | tail -1 \
    | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/')"
  [ -n "$udid" ] || fail "no available simulator named '$DIRECTOR_SIMULATOR'"
  echo "$udid"
}
