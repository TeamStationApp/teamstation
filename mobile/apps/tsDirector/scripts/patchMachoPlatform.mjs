#!/usr/bin/env node
/**
 * Retarget every Mach-O member of a thin static archive from one platform to another.
 *
 * `libndi_ios.a` from the free NDI SDK carries an arm64 slice built for the iOS *device*
 * (Mach-O platform 2) and an x86_64 slice built for the *simulator* (platform 7). There is no
 * arm64 simulator slice, and Xcode will not run an x86_64 simulator on Apple Silicon, so
 * without this the app cannot be built for any iPad simulator on this machine at all.
 *
 * `LC_BUILD_VERSION.platform` is one 4-byte word inside a load command whose size does not
 * change, so retargeting it is a byte edit rather than a rewrite. Two things that do not work,
 * both learned the expensive way:
 *
 *   - `vtool -set-build-version 7 ... -replace` rejects every one of these objects with
 *     "not enough space to hold load commands", because it rebuilds the whole command block.
 *   - Extracting the members with `ar x`, patching, and re-archiving silently loses six
 *     duplicate member names, and the link then fails on the symbols they defined
 *     (`Processing::NDI::Config::configuration::*`).
 *
 * So this patches the archive in place, walking the ar directory itself.
 *
 *     patchMachoPlatform.mjs 2 7 libndi_ios_sim_arm64.a && ranlib libndi_ios_sim_arm64.a
 */
import { readFileSync, writeFileSync } from 'node:fs'

const MH_MAGIC_64 = 0xfeedfacf
const LC_BUILD_VERSION = 0x32
const ARMAG = Buffer.from('!<arch>\n', 'latin1')
const AR_HEADER_SIZE = 60
const AR_SIZE_OFFSET = 48
const AR_SIZE_LENGTH = 10

const PLATFORM_NAMES = {
  1: 'macOS',
  2: 'iOS',
  3: 'tvOS',
  6: 'Mac Catalyst',
  7: 'iOS Simulator'
}

/** Rewrites this member's LC_BUILD_VERSION platform. Returns how many commands changed. */
function patchMacho(data, base, wantFrom, wantTo) {
  if (base + 32 > data.length) return 0
  if (data.readUInt32LE(base) !== MH_MAGIC_64) return 0

  const ncmds = data.readUInt32LE(base + 16)
  let offset = base + 32
  let changed = 0
  for (let i = 0; i < ncmds; i++) {
    const cmd = data.readUInt32LE(offset)
    const cmdsize = data.readUInt32LE(offset + 4)
    if (cmdsize === 0) break
    if (cmd === LC_BUILD_VERSION && data.readUInt32LE(offset + 8) === wantFrom) {
      data.writeUInt32LE(wantTo, offset + 8)
      changed += 1
    }
    offset += cmdsize
  }
  return changed
}

function patchArchive(path, wantFrom, wantTo) {
  const data = readFileSync(path)
  if (!data.subarray(0, ARMAG.length).equals(ARMAG)) {
    console.error(`${path}: not a thin ar archive (lipo -thin it first)`)
    process.exit(1)
  }

  let position = ARMAG.length
  let members = 0
  let changed = 0
  while (position + AR_HEADER_SIZE <= data.length) {
    const name = data.toString('latin1', position, position + 16)
    const size = Number(
      data
        .toString(
          'latin1',
          position + AR_SIZE_OFFSET,
          position + AR_SIZE_OFFSET + AR_SIZE_LENGTH
        )
        .trim()
    )

    let content = position + AR_HEADER_SIZE
    // BSD long names live in the member's own payload and are counted in its size, so the
    // Mach-O starts after them but the walk still advances by the recorded size.
    if (name.startsWith('#1/')) content += Number(name.slice(3).trim())

    members += 1
    changed += patchMacho(data, content, wantFrom, wantTo)

    position += AR_HEADER_SIZE + size
    if (size % 2 === 1) position += 1
  }

  writeFileSync(path, data)
  return { members, changed }
}

const [wantFrom, wantTo, path] = process.argv.slice(2)
if (path == null || process.argv.length !== 5) {
  console.error('patchMachoPlatform.mjs <from> <to> <archive>')
  process.exit(2)
}
const from = Number(wantFrom)
const to = Number(wantTo)
const { members, changed } = patchArchive(path, from, to)
const source = PLATFORM_NAMES[from] ?? from
const target = PLATFORM_NAMES[to] ?? to
console.log(`${path}: ${members} members, ${changed} retargeted ${source} -> ${target}`)
if (changed === 0) {
  console.log('nothing changed - the archive was already retargeted, or the platform is wrong')
  process.exit(1)
}
