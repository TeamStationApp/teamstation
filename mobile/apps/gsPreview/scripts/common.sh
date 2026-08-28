#!/usr/bin/env bash
# Shared configuration for the Preview build scripts.
set -euo pipefail

PREVIEW_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PREVIEW_ROOT

export PREVIEW_SCHEME="${PREVIEW_SCHEME:-Preview}"
export PREVIEW_PROJECT="$PREVIEW_ROOT/Preview.xcodeproj"
export PREVIEW_DERIVED_DATA="${PREVIEW_DERIVED_DATA:-$PREVIEW_ROOT/DerivedData}"
export PREVIEW_SIMULATOR="${PREVIEW_SIMULATOR:-iPhone 17 Pro}"
export PREVIEW_BUNDLE_ID="${PREVIEW_BUNDLE_ID:-co.gamestation.preview}"
export PREVIEW_TEAM_ID="${PREVIEW_TEAM_ID:-G5LQ7MERPK}"
export PREVIEW_DEVICE_UDID="${PREVIEW_DEVICE_UDID:-00008110-0006098A02FA801E}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"
}

resolve_simulator_udid() {
  if [ -n "${PREVIEW_SIMULATOR_UDID:-}" ]; then
    echo "$PREVIEW_SIMULATOR_UDID"
    return 0
  fi
  local udid
  udid="$(xcrun simctl list devices available \
    | grep -F "$PREVIEW_SIMULATOR (" \
    | tail -1 \
    | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/')"
  [ -n "$udid" ] || fail "no available simulator named '$PREVIEW_SIMULATOR'"
  echo "$udid"
}
