#!/usr/bin/env bash
# Shared configuration for the Director build scripts.
set -euo pipefail

DIRECTOR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DIRECTOR_ROOT

export DIRECTOR_SCHEME="${DIRECTOR_SCHEME:-Director}"
export DIRECTOR_PROJECT="$DIRECTOR_ROOT/Director.xcodeproj"
export DIRECTOR_DERIVED_DATA="${DIRECTOR_DERIVED_DATA:-$DIRECTOR_ROOT/DerivedData}"
export DIRECTOR_BUNDLE_ID="${DIRECTOR_BUNDLE_ID:-co.gamestation.director}"
export DIRECTOR_TEAM_ID="${DIRECTOR_TEAM_ID:-G5LQ7MERPK}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"
}

# Callers pass the target. The same simulator name exists under several runtimes, and more than
# one iPad can be attached, so a default UDID would send parallel agents to the same machine.
require_simulator_udid() {
  [ -n "${DIRECTOR_SIMULATOR_UDID:-}" ] || fail "set DIRECTOR_SIMULATOR_UDID to the simulator UDID"
  echo "$DIRECTOR_SIMULATOR_UDID"
}

require_device_udid() {
  [ -n "${DIRECTOR_DEVICE_UDID:-}" ] || fail "set DIRECTOR_DEVICE_UDID to the device UDID"
  echo "$DIRECTOR_DEVICE_UDID"
}

resolve_simulator_udid() {
  require_simulator_udid
}
