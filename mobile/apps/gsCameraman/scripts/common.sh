#!/usr/bin/env bash
# Shared configuration for the Cameraman build scripts.
set -euo pipefail

CAMERAMAN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CAMERAMAN_ROOT

export CAMERAMAN_SCHEME="${CAMERAMAN_SCHEME:-Cameraman}"
export CAMERAMAN_PROJECT="$CAMERAMAN_ROOT/Cameraman.xcodeproj"
export CAMERAMAN_DERIVED_DATA="${CAMERAMAN_DERIVED_DATA:-$CAMERAMAN_ROOT/DerivedData}"
# Closest high-end iPhone simulator installed on this machine.
export CAMERAMAN_SIMULATOR="${CAMERAMAN_SIMULATOR:-iPhone 16 Pro}"
export CAMERAMAN_BUNDLE_ID="${CAMERAMAN_BUNDLE_ID:-co.gamestation.cameraman}"
export CAMERAMAN_TEAM_ID="${CAMERAMAN_TEAM_ID:-G5LQ7MERPK}"

# Whichever iPhone is plugged in, rather than a name in a script. The fallback is the iPhone 13 Pro
# every capability number in docs/capabilities.md was measured on; an iPhone 17 Pro has a different
# lens set and different format list, so which handset produced a reading always matters.
resolve_device_udid() {
  xcrun devicectl list devices --json-output /dev/stdout 2>/dev/null \
    | node -e '
      let raw = ""
      process.stdin.on("data", chunk => (raw += chunk)).on("end", () => {
        const data = JSON.parse(raw.slice(raw.indexOf("{")))
        const phones = data.result.devices.filter(entry =>
          (entry.hardwareProperties.deviceType ?? "") === "iPhone" &&
          entry.connectionProperties.tunnelState === "connected"
        )
        if (phones[0]) process.stdout.write(phones[0].hardwareProperties.udid)
      })
    ' 2>/dev/null
}

if [ -z "${CAMERAMAN_DEVICE_UDID:-}" ]; then
  CAMERAMAN_DEVICE_UDID="$(resolve_device_udid || true)"
  : "${CAMERAMAN_DEVICE_UDID:=22222222-2222222222222222}"
fi
export CAMERAMAN_DEVICE_UDID

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"
}

# The same simulator name exists under several installed runtimes, which makes a name-based
# -destination ambiguous, so always resolve to a concrete UDID.
resolve_simulator_udid() {
  if [ -n "${CAMERAMAN_SIMULATOR_UDID:-}" ]; then
    echo "$CAMERAMAN_SIMULATOR_UDID"
    return 0
  fi
  local udid
  udid="$(xcrun simctl list devices available \
    | grep -F "$CAMERAMAN_SIMULATOR (" \
    | tail -1 \
    | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/')"
  [ -n "$udid" ] || fail "no available simulator named '$CAMERAMAN_SIMULATOR'"
  echo "$udid"
}

# The device's address on the LAN, which is what an RTSP client connects to. Read from the device
# rather than assumed, because it changes with the network.
resolve_device_address() {
  xcrun devicectl device info details --device "$CAMERAMAN_DEVICE_UDID" --json-output /dev/stdout 2>/dev/null \
    | node -e '
      let raw = ""
      process.stdin.on("data", chunk => (raw += chunk)).on("end", () => {
        try {
          const data = JSON.parse(raw.slice(raw.indexOf("{")))
          const interfaces = data.result?.connectionProperties?.localHostnames ?? []
          if (interfaces[0]) process.stdout.write(interfaces[0])
        } catch {}
      })
    ' 2>/dev/null
}
