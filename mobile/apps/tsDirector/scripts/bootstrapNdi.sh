#!/usr/bin/env bash
# Turns the free NDI SDK installer into the xcframework DirectorNDI links against.
#
# The library is ~380 MB across its slices, so it is built here rather than committed;
# `Vendor/` is gitignored and `bootstrap.sh` calls this before generating the project.
#
# The interesting step is the simulator slice. `lib/iOS/libndi_ios.a` ships arm64 for the
# device and x86_64 for the simulator, and Xcode will not run an x86_64 simulator on Apple
# Silicon — so a stock SDK cannot be built for any iPad simulator on this machine.
# `patchMachoPlatform.mjs` retargets a copy of the device slice to the simulator platform,
# which is a byte edit of one load-command field. See that script for why `vtool` and
# `ar x` both fail here.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

NDI_PKG_URL="${NDI_PKG_URL:-https://downloads.ndi.tv/SDK/NDI_SDK_Mac/Install_NDI_SDK_v6_Apple.pkg}"
NDI_PACKAGE="$(cd "$DIRECTOR_ROOT/../common/DirectorNDI" 2>/dev/null && pwd || echo "$DIRECTOR_ROOT/../common/DirectorNDI")"
VENDOR="$NDI_PACKAGE/Vendor"
XCFRAMEWORK="$VENDOR/libndi.xcframework"
HEADERS="$NDI_PACKAGE/Sources/CNDI/include"
STAGED_HEADERS=""
WORK="${NDI_WORK_DIR:-$VENDOR/.work}"

PKG_PATH=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pkg) PKG_PATH="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --help|-h)
      cat <<'USAGE'
Usage: bootstrapNdi.sh [--pkg <Install_NDI_SDK_v6_Apple.pkg>] [--force]

  --pkg    Use an already-downloaded installer instead of fetching one
  --force  Rebuild even if the xcframework is already present

Set NDI_PKG_URL to point at a different SDK build.
USAGE
      exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

require lipo
require libtool
require xcodebuild
require python3

if [ -d "$XCFRAMEWORK" ] && [ "$FORCE" -eq 0 ]; then
  log "NDI xcframework already present: $XCFRAMEWORK"
  exit 0
fi

mkdir -p "$VENDOR" "$WORK"

if [ -z "$PKG_PATH" ]; then
  PKG_PATH="$WORK/Install_NDI_SDK_v6_Apple.pkg"
  if [ ! -f "$PKG_PATH" ]; then
    log "Downloading the NDI SDK (about 225 MB)"
    curl -fL --progress-bar "$NDI_PKG_URL" -o "$PKG_PATH.partial"
    mv "$PKG_PATH.partial" "$PKG_PATH"
  else
    log "Using cached installer: $PKG_PATH"
  fi
fi
[ -f "$PKG_PATH" ] || fail "installer not found: $PKG_PATH"

EXPANDED="$WORK/expanded"
rm -rf "$EXPANDED"
log "Expanding the installer"
pkgutil --expand-full "$PKG_PATH" "$EXPANDED"

SDK_ROOT="$EXPANDED/NDI_SDK_Component.pkg/Payload/NDI SDK for Apple"
[ -d "$SDK_ROOT" ] || fail "unexpected installer layout: no 'NDI SDK for Apple' under $EXPANDED"
log "SDK: $(cat "$SDK_ROOT/Version.txt")"

# The module map and umbrella header beside these are ours and are committed, so only the
# vendored headers are replaced. They are gitignored; nothing here belongs in the repository.
log "Copying headers"
mkdir -p "$HEADERS"
rm -f "$HEADERS"/Processing.NDI.*.h
cp "$SDK_ROOT/include/"*.h "$HEADERS/"

STAGED_HEADERS="$WORK/headers"
rm -rf "$STAGED_HEADERS"
mkdir -p "$STAGED_HEADERS"
cp "$SDK_ROOT/include/"*.h "$STAGED_HEADERS/"

DEVICE_LIB="$WORK/libndi_ios_device.a"
SIM_ARM64="$WORK/libndi_ios_sim_arm64.a"
SIM_X86="$WORK/libndi_ios_sim_x86_64.a"
SIM_LIB="$WORK/libndi_ios_sim.a"

log "Splitting the fat library"
lipo -thin arm64 "$SDK_ROOT/lib/iOS/libndi_ios.a" -output "$DEVICE_LIB"
lipo -thin x86_64 "$SDK_ROOT/lib/iOS/libndi_ios.a" -output "$SIM_X86"

log "Retargeting the arm64 slice for the iOS simulator"
cp "$DEVICE_LIB" "$SIM_ARM64"
node "$DIRECTOR_ROOT/scripts/patchMachoPlatform.mjs" 2 7 "$SIM_ARM64"
ranlib "$SIM_ARM64"

log "Recombining the simulator slices"
lipo -create "$SIM_ARM64" "$SIM_X86" -output "$SIM_LIB"

log "Building the xcframework"
rm -rf "$XCFRAMEWORK"
xcodebuild -create-xcframework \
  -library "$DEVICE_LIB" -headers "$STAGED_HEADERS" \
  -library "$SIM_LIB" -headers "$STAGED_HEADERS" \
  -output "$XCFRAMEWORK" >/dev/null

# A missing simulator slice is the failure this whole script exists to prevent, and it is
# invisible until a simulator build fails on an unrelated-looking link error.
for slice in ios-arm64 ios-arm64_x86_64-simulator; do
  [ -d "$XCFRAMEWORK/$slice" ] || fail "xcframework is missing the $slice slice"
done

log "Copying licences"
cp "$SDK_ROOT/licenses/libndi_licenses.txt" "$VENDOR/libndi_licenses.txt"
cp "$SDK_ROOT/NDI SDK License Agreement.pdf" "$VENDOR/NDI SDK License Agreement.pdf"

log "NDI xcframework ready: $XCFRAMEWORK"
