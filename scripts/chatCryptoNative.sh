#!/bin/bash
# Builds the chat crypto core (crates/chat-crypto) as a static library for a
# phone build, with the toolchain its rust-toolchain.toml pins.
#
#   scripts/chatCryptoNative.sh ios             # from Xcode's "Build chat crypto" phase
#   scripts/chatCryptoNative.sh android <abi>[,<abi>…]   # from Gradle's buildChatCryptoRust
#
# iOS builds every architecture in $ARCHS for $PLATFORM_NAME and joins them
# with lipo into ios/build/chatCrypto/$PLATFORM_NAME/libchat_crypto.a, which
# the TeamStation target links. Android builds each ABI through cargo ndk into
# the crate's target directory, where android/app/src/main/jni/CMakeLists.txt
# finds it.
set -euo pipefail

# Xcode's run-script phases do not inherit the shell's PATH.
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate="$root/crates/chat-crypto"

die() {
  echo "error: $*" >&2
  exit 1
}

command -v cargo >/dev/null ||
  die "no cargo: install Rust with rustup (https://rustup.rs); crates/chat-crypto/rust-toolchain.toml brings the targets on first use"

# The library ships inside the app, so the build machine's paths are
# remapped away, as for the WebAssembly module (scripts/chatCryptoBuild.mjs).
# chacha20 0.9 uses its NEON code on arm64 only when asked; every phone this
# builds for has NEON, and without it ChaCha20 is the portable code.
# rustc takes the last prefix that matches, so the home directory comes
# first and the crate and cargo's home, usually under it, after.
export RUSTFLAGS="--cfg chacha20_force_neon --remap-path-prefix=$HOME=home --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=cargo --remap-path-prefix=$crate=chat-crypto"
# Where cargo writes, CARGO_TARGET_DIR (from the crate) when set.
target_dir="$crate/target"
if [ -n "${CARGO_TARGET_DIR:-}" ]; then
  case "$CARGO_TARGET_DIR" in
    /*) target_dir="$CARGO_TARGET_DIR" ;;
    *) target_dir="$crate/$CARGO_TARGET_DIR" ;;
  esac
fi

case "${1:-}" in
  ios)
    platform="${PLATFORM_NAME:?PLATFORM_NAME is set by Xcode}"
    archs="${ARCHS:?ARCHS is set by Xcode}"
    out="$root/ios/build/chatCrypto/$platform"
    mkdir -p "$out"
    libs=()
    for arch in $archs; do
      case "$platform/$arch" in
        iphoneos/arm64) target=aarch64-apple-ios ;;
        iphonesimulator/arm64) target=aarch64-apple-ios-sim ;;
        iphonesimulator/x86_64) target=x86_64-apple-ios ;;
        *) die "no Rust target for $platform $arch" ;;
      esac
      # Xcode's SDK settings are for clang, not for cargo's host build scripts.
      (cd "$crate" && env -u SDKROOT -u LIBRARY_PATH \
        cargo build --locked --release --lib --target "$target")
      libs+=("$target_dir/$target/release/libchat_crypto.a")
    done
    lipo -create "${libs[@]}" -output "$out/libchat_crypto.a"
    echo "chat crypto: $out/libchat_crypto.a ($archs)"
    ;;
  android)
    abis="${2:?usage: chatCryptoNative.sh android <abi>[,<abi>…]}"
    command -v cargo-ndk >/dev/null ||
      die "no cargo-ndk: cargo install cargo-ndk"
    if [ -z "${ANDROID_NDK_HOME:-}" ]; then
      sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
      [ -n "$sdk" ] || die "set ANDROID_NDK_HOME or ANDROID_HOME"
      ndk_version="$(sed -n 's/.*ndkVersion = "\(.*\)".*/\1/p' "$root/android/build.gradle")"
      export ANDROID_NDK_HOME="$sdk/ndk/$ndk_version"
    fi
    targets=()
    for abi in ${abis//,/ }; do targets+=(--target "$abi"); done
    (cd "$crate" && cargo ndk "${targets[@]}" --platform 28 \
      build --locked --release --lib)
    echo "chat crypto: $abis"
    ;;
  *)
    die "usage: chatCryptoNative.sh ios | android <abi>"
    ;;
esac
