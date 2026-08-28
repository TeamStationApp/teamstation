#!/usr/bin/env bash
# Generates Preview.xcodeproj from project.yml and resolves the local packages.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodegen
require xcodebuild

mkdir -p "$PREVIEW_DERIVED_DATA"

log "Xcode: $(xcodebuild -version | head -1)"
log "XcodeGen: $(xcodegen --version)"

cd "$PREVIEW_ROOT"
log "Generating $PREVIEW_PROJECT"
xcodegen generate --quiet

log "Resolving Swift packages"
xcodebuild -resolvePackageDependencies \
  -project "$PREVIEW_PROJECT" \
  -scheme "$PREVIEW_SCHEME" \
  -derivedDataPath "$PREVIEW_DERIVED_DATA" >/dev/null

log "Bootstrap complete"
