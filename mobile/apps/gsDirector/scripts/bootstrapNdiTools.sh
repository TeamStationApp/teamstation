#!/usr/bin/env bash
# Stages the macOS NDI library for the gsNdiCameras generator.
#
# The generator is the test rig: NDI Test Patterns from ndi.video/tools does publish streams, but
# it cannot burn in a stopwatch, drop a frame on command, or send a malformed one, which is most of
# what the NDI tests actually need. So it links the same SDK Director does, from the same
# installer — `bootstrapNdi.sh` caches it, and this reuses that download rather than fetching
# 225 MB twice.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

TOOL="$DIRECTOR_ROOT/../../tools/gsNdiCameras"
VENDOR="$TOOL/Vendor"
HEADERS="$TOOL/Sources/CNDIMac/include"
WORK="${NDI_WORK_DIR:-$DIRECTOR_ROOT/../common/DirectorNDI/Vendor/.work}"
SDK_ROOT="$WORK/expanded/NDI_SDK_Component.pkg/Payload/NDI SDK for Apple"

if [ ! -d "$SDK_ROOT" ]; then
  log "Expanding the NDI SDK first"
  bash "$(dirname "${BASH_SOURCE[0]}")/bootstrapNdi.sh"
fi
[ -d "$SDK_ROOT" ] || fail "no expanded SDK at $SDK_ROOT"

mkdir -p "$VENDOR" "$HEADERS"
rm -f "$HEADERS"/Processing.NDI.*.h
cp "$SDK_ROOT/include/"*.h "$HEADERS/"
cp "$SDK_ROOT/lib/macOS/libndi.dylib" "$VENDOR/libndi.dylib"

# The dylib records itself as @rpath/libndi.dylib. The package adds an rpath of
# @executable_path, so the copy sitting beside the built binary is what loads — no
# DYLD_LIBRARY_PATH, and no dependency on anything being installed system-wide.
install_name_tool -id "@rpath/libndi.dylib" "$VENDOR/libndi.dylib" 2>/dev/null || true

log "NDI tools library staged: $VENDOR/libndi.dylib"
