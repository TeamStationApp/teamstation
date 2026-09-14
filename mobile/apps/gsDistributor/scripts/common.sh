#!/usr/bin/env bash
# Shared configuration for the Distributor build scripts.
set -euo pipefail

DISTRIBUTOR_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DISTRIBUTOR_ROOT
export DISTRIBUTOR_SCHEME="${DISTRIBUTOR_SCHEME:-Distributor}"
export DISTRIBUTOR_PROJECT="$DISTRIBUTOR_ROOT/Distributor.xcodeproj"
export DISTRIBUTOR_DERIVED_DATA="${DISTRIBUTOR_DERIVED_DATA:-$DISTRIBUTOR_ROOT/DerivedData}"

log() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not installed"
}
