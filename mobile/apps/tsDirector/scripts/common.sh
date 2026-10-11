#!/usr/bin/env bash
# Shared configuration for the Director build scripts.
set -euo pipefail

DIRECTOR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DIRECTOR_ROOT

# The system directories, whatever the caller's PATH is. A login shell gets
# these from /etc/paths, but an agent, a launchd job and a CI runner each
# inherit whatever they were handed — and `bootstrapNdi.sh` calling `pkgutil`,
# which lives in /usr/sbin, then fails with `command not found` in the middle
# of expanding a 225 MB installer. Appended rather than prepended, so a tool
# somebody has deliberately put earlier still wins.
case ":$PATH:" in
  *:/usr/sbin:*) ;;
  *) export PATH="$PATH:/usr/sbin:/sbin" ;;
esac

export DIRECTOR_SCHEME="${DIRECTOR_SCHEME:-Director}"
export DIRECTOR_PROJECT="$DIRECTOR_ROOT/Director.xcodeproj"
export DIRECTOR_DERIVED_DATA="${DIRECTOR_DERIVED_DATA:-$DIRECTOR_ROOT/DerivedData}"
export DIRECTOR_BUNDLE_ID="${DIRECTOR_BUNDLE_ID:-app.teamstation.director}"
# The team that signs this app: the one in clientConfig.json unless the caller names another.
export DIRECTOR_TEAM_ID="${DIRECTOR_TEAM_ID:-$(node "$DIRECTOR_ROOT/../../../scripts/clientConfig.mjs" "$DIRECTOR_ROOT" --team)}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"
}

# The deployment's own settings for this app, from its gitignored clientConfig.json, which
# appLinks.mjs client writes: the team that signs it and the link host its sign-in links open it
# from. client_xcconfig turns them into the xcconfig every xcodebuild here passes with -xcconfig,
# and stops a build that has no clientConfig.json.
client_xcconfig() {
  CLIENT_XCCONFIG="$(node "$DIRECTOR_ROOT/../../../scripts/clientConfig.mjs" "$DIRECTOR_ROOT" --entitlements App/Director.entitlements)" \
    || fail "no clientConfig.json in $DIRECTOR_ROOT"
  export CLIENT_XCCONFIG
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
