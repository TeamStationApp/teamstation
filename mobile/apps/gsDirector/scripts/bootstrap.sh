#!/usr/bin/env bash
# Regenerates Director.xcodeproj from project.yml and checks the toolchain.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require xcodegen
require xcodebuild

cd "$DIRECTOR_ROOT"

log "Xcode: $(xcodebuild -version | head -1)"
log "XcodeGen: $(xcodegen --version)"

log "Generating Director.xcodeproj"
xcodegen generate --quiet

log "Resolving Swift packages"
xcodebuild -resolvePackageDependencies \
  -project "$DIRECTOR_PROJECT" \
  -scheme "$DIRECTOR_SCHEME" \
  -derivedDataPath "$DIRECTOR_DERIVED_DATA" >/dev/null

log "Bootstrap complete"
