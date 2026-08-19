#!/usr/bin/env bash
# Generates Cameraman.xcodeproj from project.yml and resolves the local packages.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodegen
require xcodebuild

log "Generating $CAMERAMAN_PROJECT"
cd "$CAMERAMAN_ROOT"
xcodegen generate

log "Resolving packages"
xcodebuild -resolvePackageDependencies \
  -project "$CAMERAMAN_PROJECT" \
  -scheme "$CAMERAMAN_SCHEME" \
  > "$CAMERAMAN_DERIVED_DATA/resolve.log" 2>&1 \
  || { tail -20 "$CAMERAMAN_DERIVED_DATA/resolve.log"; fail "package resolution failed"; }

log "Bootstrapped"
