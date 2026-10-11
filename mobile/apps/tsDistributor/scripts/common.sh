#!/usr/bin/env bash
# Shared configuration for the Distributor build scripts.
set -euo pipefail

DISTRIBUTOR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DISTRIBUTOR_ROOT
export DISTRIBUTOR_SCHEME="${DISTRIBUTOR_SCHEME:-Distributor}"
export DISTRIBUTOR_PROJECT="$DISTRIBUTOR_ROOT/Distributor.xcodeproj"
export DISTRIBUTOR_DERIVED_DATA="${DISTRIBUTOR_DERIVED_DATA:-$DISTRIBUTOR_ROOT/DerivedData}"
# The team that signs this app: the one in clientConfig.json unless the caller names another.
export DISTRIBUTOR_TEAM_ID="${DISTRIBUTOR_TEAM_ID:-$(node "$DISTRIBUTOR_ROOT/../../../scripts/clientConfig.mjs" "$DISTRIBUTOR_ROOT" --team)}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"
}

# The deployment's own settings for this app, from its gitignored clientConfig.json, which
# appLinks.mjs client writes: the team that signs it and the link host its sign-in links open it
# from. client_xcconfig turns them into the xcconfig every xcodebuild here passes with -xcconfig,
# and stops a build that has no clientConfig.json.
client_xcconfig() {
  CLIENT_XCCONFIG="$(node "$DISTRIBUTOR_ROOT/../../../scripts/clientConfig.mjs" "$DISTRIBUTOR_ROOT")" \
    || fail "no clientConfig.json in $DISTRIBUTOR_ROOT"
  export CLIENT_XCCONFIG
}
