#!/usr/bin/env bash
# Runs every Swift package GS Distributor is built from with `swift test` on this Mac: its own
# packages and the shared ones it stitches with.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

require swift

APPS="$(cd "$DISTRIBUTOR_ROOT/.." && pwd)"
PACKAGES=(
  "$DISTRIBUTOR_ROOT/Packages/UsbMux"
  "$DISTRIBUTOR_ROOT/Packages/DirectorClient"
  "$DISTRIBUTOR_ROOT/Packages/Distribution"
  "$DISTRIBUTOR_ROOT/Packages/CombinedVideo"
  "$APPS/common/DistributorWire"
  "$APPS/common/PeerTubeKit"
  "$APPS/common/DirectorExport"
  "$APPS/gsDirector/Packages/DirectorLink"
)

FAILED=()
for package in "${PACKAGES[@]}"; do
  name="$(basename "$package")"
  log "swift test $name"
  set +e
  output="$(cd "$package" && swift test 2>&1)"
  status=$?
  set -e
  echo "$output" | grep -E "error:|✘ Test run|✔ Test run" || true
  # A run that never reached its tests prints no summary at all, so require the passing one.
  if [ $status -ne 0 ] || ! echo "$output" | grep -q "✔ Test run"; then
    FAILED+=("$name")
  fi
done

[ ${#FAILED[@]} -eq 0 ] || fail "failed: ${FAILED[*]}"
log "All packages passed"
