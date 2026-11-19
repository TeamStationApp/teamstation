#!/usr/bin/env bash
# Shared configuration for the TS Speedy build scripts.
set -euo pipefail

SPEEDY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SPEEDY_ROOT

export SPEEDY_SCHEME="${SPEEDY_SCHEME:-Speedy}"
export SPEEDY_PROJECT="$SPEEDY_ROOT/Speedy.xcodeproj"
export SPEEDY_DERIVED_DATA="${SPEEDY_DERIVED_DATA:-$SPEEDY_ROOT/DerivedData}"
export SPEEDY_SIMULATOR="${SPEEDY_SIMULATOR:-iPhone 16 Pro}"
export SPEEDY_BUNDLE_ID="${SPEEDY_BUNDLE_ID:-app.teamstation.speedy}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"
}

# The team that signs the app, from the gitignored clientConfig.json beside project.yml. Mason
# writes that file for its builds; for a local build it is one line, {"appleTeamId": "<team>"}.
# TS Speedy has no link host, so it claims no entitlements.
client_xcconfig() {
  CLIENT_XCCONFIG="$(node "$SPEEDY_ROOT/../../../scripts/clientConfig.mjs" "$SPEEDY_ROOT")" \
    || fail "no clientConfig.json in $SPEEDY_ROOT"
  export CLIENT_XCCONFIG
  SPEEDY_TEAM_ID="${SPEEDY_TEAM_ID:-$(node "$SPEEDY_ROOT/../../../scripts/clientConfig.mjs" "$SPEEDY_ROOT" --team)}"
  export SPEEDY_TEAM_ID
}

# The same simulator name exists under several installed runtimes, so always resolve to a UDID.
resolve_simulator_udid() {
  if [ -n "${SPEEDY_SIMULATOR_UDID:-}" ]; then
    echo "$SPEEDY_SIMULATOR_UDID"
    return 0
  fi
  local udid
  udid="$(xcrun simctl list devices available \
    | grep -F "$SPEEDY_SIMULATOR (" \
    | tail -1 \
    | sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/')"
  [ -n "$udid" ] || fail "no available simulator named '$SPEEDY_SIMULATOR'"
  echo "$udid"
}
