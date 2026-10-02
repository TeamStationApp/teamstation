#!/usr/bin/env python3
"""Retarget every Mach-O member of a thin static archive from one platform to another.

`libndi_ios.a` from the free NDI SDK carries an arm64 slice built for the iOS *device*
(Mach-O platform 2) and an x86_64 slice built for the *simulator* (platform 7). There is no
arm64 simulator slice, and Xcode will not run an x86_64 simulator on Apple Silicon, so
without this the app cannot be built for any iPad simulator on this machine at all.

`LC_BUILD_VERSION.platform` is one 4-byte word inside a load command whose size does not
change, so retargeting it is a byte edit rather than a rewrite. Two things that do not work,
both learned the expensive way:

  * `vtool -set-build-version 7 ... -replace` rejects every one of these objects with
    "not enough space to hold load commands", because it rebuilds the whole command block.
  * Extracting the members with `ar x`, patching, and re-archiving silently loses six
    duplicate member names, and the link then fails on the symbols they defined
    (`Processing::NDI::Config::configuration::*`).

So this patches the archive in place, walking the ar directory itself.

    patchMachoPlatform.py 2 7 libndi_ios_sim_arm64.a && ranlib libndi_ios_sim_arm64.a
"""

import struct
import sys

MH_MAGIC_64 = 0xFEEDFACF
LC_BUILD_VERSION = 0x32
ARMAG = b"!<arch>\n"
AR_HEADER_SIZE = 60
AR_SIZE_OFFSET = 48
AR_SIZE_LENGTH = 10

PLATFORM_NAMES = {1: "macOS", 2: "iOS", 3: "tvOS", 6: "Mac Catalyst", 7: "iOS Simulator"}


def patch_macho(data: bytearray, base: int, want_from: int, want_to: int) -> int:
    """Rewrite this member's LC_BUILD_VERSION platform. Returns how many commands changed."""
    if base + 32 > len(data):
        return 0
    if struct.unpack_from("<I", data, base)[0] != MH_MAGIC_64:
        return 0

    ncmds = struct.unpack_from("<I", data, base + 16)[0]
    offset = base + 32
    changed = 0
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", data, offset)
        if cmdsize == 0:
            break
        if cmd == LC_BUILD_VERSION:
            if struct.unpack_from("<I", data, offset + 8)[0] == want_from:
                struct.pack_into("<I", data, offset + 8, want_to)
                changed += 1
        offset += cmdsize
    return changed


def patch_archive(path: str, want_from: int, want_to: int) -> tuple[int, int]:
    with open(path, "rb") as handle:
        data = bytearray(handle.read())
    if data[: len(ARMAG)] != ARMAG:
        raise SystemExit(f"{path}: not a thin ar archive (lipo -thin it first)")

    position = len(ARMAG)
    members = 0
    changed = 0
    while position + AR_HEADER_SIZE <= len(data):
        name = bytes(data[position : position + 16]).decode("ascii", "replace")
        size_field = bytes(
            data[position + AR_SIZE_OFFSET : position + AR_SIZE_OFFSET + AR_SIZE_LENGTH]
        )
        size = int(size_field.decode("ascii").strip())

        content = position + AR_HEADER_SIZE
        # BSD long names live in the member's own payload and are counted in its size, so the
        # Mach-O starts after them but the walk still advances by the recorded size.
        if name.startswith("#1/"):
            content += int(name[3:].strip())

        members += 1
        changed += patch_macho(data, content, want_from, want_to)

        position += AR_HEADER_SIZE + size
        if size % 2:
            position += 1

    with open(path, "wb") as handle:
        handle.write(data)
    return members, changed


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__)
        return 2
    want_from, want_to, path = int(argv[1]), int(argv[2]), argv[3]
    members, changed = patch_archive(path, want_from, want_to)
    source = PLATFORM_NAMES.get(want_from, want_from)
    target = PLATFORM_NAMES.get(want_to, want_to)
    print(f"{path}: {members} members, {changed} retargeted {source} -> {target}")
    if changed == 0:
        print("nothing changed - the archive was already retargeted, or the platform is wrong")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
