#!/bin/bash
# Builds HiGHS (native/highs/highs-source.json) and the Auto-Scheduler's
# engine (native/scheduler) as static libraries for a phone build, for the
# NativeScheduler module.
#
#   scripts/highsNative.sh ios     # from Xcode's "Build the scheduler" phase
#
# It fetches the pinned source, and CMake when the host has none
# (scripts/highsSource.mjs), builds every architecture in $ARCHS for
# $PLATFORM_NAME, and joins them with lipo into
# ios/build/highs/$PLATFORM_NAME/libhighs.a, libhighs_extras.a and
# libscheduler_core.a, with HiGHS's generated HConfig.h in
# ios/build/highs/$PLATFORM_NAME/include. The TeamStation target links all
# three and reads the headers from the sources. HiGHS of the same pin and
# architectures is kept and not rebuilt; the engine is rebuilt as its
# sources change, by CMake.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
  echo "error: $*" >&2
  exit 1
}

# Xcode's run-script phases do not inherit the shell's PATH; React Native's
# own phases read node from .xcode.env the same way.
for env in "$root/ios/.xcode.env" "$root/ios/.xcode.env.local"; do
  # shellcheck disable=SC1090
  [ -f "$env" ] && source "$env"
done
node="${NODE_BINARY:-node}"
command -v "$node" >/dev/null || die "no node: set NODE_BINARY in ios/.xcode.env.local"

case "${1:-}" in
  ios)
    platform="${PLATFORM_NAME:?PLATFORM_NAME is set by Xcode}"
    archs="${ARCHS:?ARCHS is set by Xcode}"
    target="${IPHONEOS_DEPLOYMENT_TARGET:-18.0}"
    source_dir="$("$node" "$root/scripts/highsSource.mjs")"
    cmake="$("$node" "$root/scripts/highsSource.mjs" --cmake)"
    pin="$(shasum -a 256 "$root/native/highs/highs-source.json" | cut -d' ' -f1)"
    out="$root/ios/build/highs/$platform"
    stamp="$pin $archs $target"
    highs_current=0
    if [ -f "$out/.built" ] && [ "$(cat "$out/.built")" = "$stamp" ]; then
      highs_current=1
      echo "HiGHS: $out is current ($archs)"
    fi
    mkdir -p "$out/include"
    highs=()
    extras=()
    engines=()
    for arch in $archs; do
      work="$root/ios/build/highs/work/$platform-$arch"
      engine="$root/ios/build/highs/work/$platform-$arch-scheduler"
      ios_flags=(
        -DCMAKE_SYSTEM_NAME=iOS
        -DCMAKE_OSX_SYSROOT="$platform"
        -DCMAKE_OSX_ARCHITECTURES="$arch"
        -DCMAKE_OSX_DEPLOYMENT_TARGET="$target"
        -DCMAKE_BUILD_TYPE=Release
      )
      if [ "$highs_current" = 0 ]; then
        # Xcode's SDK settings are for its own compiles, not for CMake's.
        env -u SDKROOT -u LIBRARY_PATH -u CPATH -u CC -u CXX \
          "$cmake" -S "$source_dir" -B "$work" "${ios_flags[@]}" \
          -DBUILD_SHARED_LIBS=OFF \
          -DBUILD_SHARED_EXTRAS_LIB=OFF \
          -DFAST_BUILD=ON \
          -DZLIB=OFF \
          -DBUILD_TESTING=OFF \
          -DBUILD_EXAMPLES=OFF \
          -DBUILD_CXX_EXE=OFF
        env -u SDKROOT -u LIBRARY_PATH -u CPATH -u CC -u CXX \
          "$cmake" --build "$work" --target highs --config Release -j "$(sysctl -n hw.ncpu)"
        cp "$work/HConfig.h" "$out/include/HConfig.h"
      fi
      highs+=("$work/lib/libhighs.a")
      extras+=("$work/lib/libhighs_extras.a")
      # The engine against this architecture's HiGHS.
      env -u SDKROOT -u LIBRARY_PATH -u CPATH -u CC -u CXX \
        "$cmake" -S "$root/native/scheduler" -B "$engine" "${ios_flags[@]}" \
        -DHIGHS_SOURCE="$source_dir" \
        -DHIGHS_BUILD="$work"
      env -u SDKROOT -u LIBRARY_PATH -u CPATH -u CC -u CXX \
        "$cmake" --build "$engine" --target scheduler_core --config Release -j "$(sysctl -n hw.ncpu)"
      engines+=("$engine/libscheduler_core.a")
    done
    if [ "$highs_current" = 0 ]; then
      lipo -create "${highs[@]}" -output "$out/libhighs.a"
      lipo -create "${extras[@]}" -output "$out/libhighs_extras.a"
      echo "$stamp" > "$out/.built"
    fi
    lipo -create "${engines[@]}" -output "$out/libscheduler_core.a"
    echo "scheduler: $out/libhighs.a, libhighs_extras.a and libscheduler_core.a ($archs)"
    ;;
  *)
    die "usage: highsNative.sh ios"
    ;;
esac
