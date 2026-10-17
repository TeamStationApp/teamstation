import { expect } from 'chai'
import { describe, it } from 'mocha'

import vectors from '../test/wallClockSeiVectors.json'
import {
  addEmulationPrevention,
  decodeWallClockSei,
  encodeWallClockSei,
  isPlausibleWallMs,
  isSliceNal,
  nalType,
  removeEmulationPrevention,
  type SeiCodec,
  WALL_CLOCK_SEI_UUID
} from './wallClockSei'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const bytes = (text: string): Uint8Array =>
  Uint8Array.from(Buffer.from(text, 'hex'))
const CODECS: SeiCodec[] = ['h264', 'hevc']
const HEADER = { h264: 1, hevc: 2 }

/** U22, and U27's foreign and truncated messages. */
describe('the wall-clock SEI', function () {
  it('describes itself in the shared vectors', function () {
    expect(vectors.uuid).equals(hex(WALL_CLOCK_SEI_UUID))
    expect(vectors.version).equals(1)
    expect(vectors.payloadType).equals(5)
    expect(vectors.payloadSize).equals(26)
    expect(vectors.vectors.length).greaterThan(2)
  })

  for (const vector of vectors.vectors) {
    for (const codec of CODECS) {
      it(`encodes and decodes ${vector.name} for ${codec}`, function () {
        const stamp = { wallMs: vector.wallMs, corrected: vector.corrected }
        const nal = encodeWallClockSei(codec, stamp)
        expect(hex(nal)).equals(vector[codec])
        // A wall outside this century (the epoch's own vector) is written
        // byte for byte, and refused when read.
        expect(decodeWallClockSei(codec, bytes(vector[codec]))).deep.equals(
          isPlausibleWallMs(vector.wallMs) ? stamp : null
        )
        // The payload under the emulation prevention: type, size, payload,
        // stop bit.
        const rbsp = removeEmulationPrevention(nal.subarray(HEADER[codec]))
        expect(hex(rbsp)).equals(`051a${vector.payloadHex}80`)
        expect(vector.payloadHex.slice(34, 50)).equals(vector.wallHex)
      })
    }
  }

  it('escapes a wall whose bytes hold 00 00 03', function () {
    const vector = vectors.vectors.find(one => one.wallHex.includes('000003'))
    expect(vector, 'the vectors include one').not.equals(undefined)
    // The three becomes `00 00 03 03`: the 03 the wall holds, escaped.
    expect(vector?.h264).contains('00000303')
    expect(vector?.hevc).contains('00000303')
  })

  it('round-trips emulation prevention over every run of zeros', function () {
    const raw = bytes('000000000100000200000300000400')
    const escaped = addEmulationPrevention(raw)
    expect(hex(escaped)).equals('00000300000301000003020000030300000400')
    expect(hex(removeEmulationPrevention(escaped))).equals(hex(raw))
  })

  it('reads the NAL type and tells a slice from the rest', function () {
    const h264 = encodeWallClockSei('h264', { wallMs: 1, corrected: true })
    const hevc = encodeWallClockSei('hevc', { wallMs: 1, corrected: true })
    expect(nalType('h264', h264)).equals(6)
    expect(nalType('hevc', hevc)).equals(39)
    expect(isSliceNal('h264', h264)).equals(false)
    expect(isSliceNal('hevc', hevc)).equals(false)
    expect(isSliceNal('h264', Uint8Array.of(0x65))).equals(true) // IDR
    expect(isSliceNal('h264', Uint8Array.of(0x41))).equals(true)
    expect(isSliceNal('h264', Uint8Array.of(0x67))).equals(false) // SPS
    expect(isSliceNal('hevc', Uint8Array.of(0x26, 0x01))).equals(true) // IDR
    expect(isSliceNal('hevc', Uint8Array.of(0x02, 0x01))).equals(true)
    expect(isSliceNal('hevc', Uint8Array.of(0x40, 0x01))).equals(false) // VPS
  })

  it('finds its own message beside an encoder’s', function () {
    const ours = encodeWallClockSei('hevc', {
      wallMs: 1_700_000_000_000,
      corrected: false
    })
    // An encoder's own user data first, with a size that needs an `ff`
    // byte, then ours.
    const theirs = new Uint8Array(3 + 300)
    theirs[0] = 5
    theirs[1] = 0xff
    theirs[2] = 300 - 255
    theirs.fill(0x11, 3)
    const rbsp = removeEmulationPrevention(ours.subarray(2))
    const both = Uint8Array.from([
      0x4e,
      0x01,
      ...addEmulationPrevention(Uint8Array.from([...theirs, ...rbsp]))
    ])
    expect(decodeWallClockSei('hevc', both)).deep.equals({
      wallMs: 1_700_000_000_000,
      corrected: false
    })
  })

  it('passes over another UUID, another version, a truncated message and other NAL units', function () {
    const nal = encodeWallClockSei('h264', {
      wallMs: 1_700_000_000_042,
      corrected: true
    })
    expect(decodeWallClockSei('h264', nal)).deep.equals({
      wallMs: 1_700_000_000_042,
      corrected: true
    })
    const foreign = Uint8Array.from(nal)
    foreign[3] ^= 0xff // the UUID's first byte
    expect(decodeWallClockSei('h264', foreign)).equals(null)

    const rbsp = removeEmulationPrevention(nal.subarray(1))
    const versioned = Uint8Array.from(rbsp)
    versioned[2 + 16] = 2
    expect(
      decodeWallClockSei(
        'h264',
        Uint8Array.from([6, ...addEmulationPrevention(versioned)])
      )
    ).equals(null)

    // Cut short: the size says 26 bytes and fewer follow.
    expect(decodeWallClockSei('h264', nal.subarray(0, 20))).equals(null)
    // A size that runs off the end in `ff` bytes.
    expect(
      decodeWallClockSei('h264', Uint8Array.of(6, 5, 0xff, 0xff, 0xff))
    ).equals(null)
    // Another payload type, too small to be ours.
    expect(decodeWallClockSei('h264', Uint8Array.of(6, 4, 1, 0, 0x80))).equals(
      null
    )
    expect(decodeWallClockSei('h264', Uint8Array.of(0x65, 1, 2, 3))).equals(
      null
    )
    expect(decodeWallClockSei('hevc', Uint8Array.of(0x4e))).equals(null)
  })

  it('refuses a wall that is not a time of this century', function () {
    for (const wallMs of [
      0,
      -1,
      // A day before 2000, and 2100 itself.
      946_684_800_000 - 86_400_000,
      4_102_444_800_000,
      // Past what a date can hold, and past what a double holds exactly.
      8.64e15 + 1,
      2 ** 62
    ]) {
      expect(isPlausibleWallMs(wallMs), String(wallMs)).equals(false)
      for (const codec of CODECS) {
        const nal = encodeWallClockSei(codec, { wallMs, corrected: true })
        expect(decodeWallClockSei(codec, nal), String(wallMs)).equals(null)
      }
    }
    for (const wallMs of [
      946_684_800_000, 1_700_000_000_000, 4_102_444_799_999
    ])
      expect(isPlausibleWallMs(wallMs), String(wallMs)).equals(true)
    expect(isPlausibleWallMs(Number.NaN)).equals(false)
    expect(isPlausibleWallMs(1_700_000_000_000.5)).equals(false)
  })
})
