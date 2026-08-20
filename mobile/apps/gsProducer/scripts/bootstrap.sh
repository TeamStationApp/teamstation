#!/usr/bin/env bash
# Regenerates Producer.xcodeproj from project.yml and checks the toolchain.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodegen
require xcodebuild

cd "$PRODUCER_ROOT"

log "Xcode: $(xcodebuild -version | head -1)"
log "XcodeGen: $(xcodegen --version)"

log "Generating Producer.xcodeproj"
xcodegen generate --quiet

log "Resolving Swift packages"
xcodebuild -resolvePackageDependencies \
  -project "$PRODUCER_PROJECT" \
  -scheme "$PRODUCER_SCHEME" \
  -derivedDataPath "$PRODUCER_DERIVED_DATA" >/dev/null

log "Bootstrap complete"
