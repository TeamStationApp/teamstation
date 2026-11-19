#!/usr/bin/env bash
# Generates Speedy.xcodeproj from project.yml and resolves the local packages.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodegen
require xcodebuild

log "Generating $SPEEDY_PROJECT"
cd "$SPEEDY_ROOT"
xcodegen generate

log "Resolving packages"
mkdir -p "$SPEEDY_DERIVED_DATA"
xcodebuild -resolvePackageDependencies \
  -project "$SPEEDY_PROJECT" \
  -scheme "$SPEEDY_SCHEME" \
  > "$SPEEDY_DERIVED_DATA/resolve.log" 2>&1 \
  || { tail -20 "$SPEEDY_DERIVED_DATA/resolve.log"; fail "package resolution failed"; }

log "Bootstrapped"
