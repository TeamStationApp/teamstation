import { expect } from 'chai'
import { describe, it } from 'mocha'

import { STREAM_REFUSAL_PREFIXES } from '../../common/api'
import { avcCRecord, hvcCRecord, parameterSetNals } from './frameWallFixture'
import { BitWriter, toPayload } from './nalBits'
import {
  avcPictureSize,
  hevcPictureSize,
  type PictureSize,
  pictureSizeOf,
  sizeAccepted,
  sizeRefusal
} from './pictureSize'

/** SPS units libx264 and libx265 wrote, emulation prevention bytes and all. */
const AVC_SPS = {
  '1280x720': '6764001facd9405005bb0110000003001000000303c0f1831960',
  '1280x720@60': '67640020acd9405005bb0110000003001000000780f1831960',
  '1920x1080': '67640028acd940780227e5c044000003000400000300f03c60c658',
  '640x360': '6764001eacd940a02ff970110000030001000003003c0f162d96',
  '2560x1440': '67640032acd9402800b5b0110000030001000003003c0f183196',
  '1080x1920': '67640028acd9404403c797c044000003000400000300f03c60c658',
  '1440x1080': '67640028acd9405a0227e5c044000003000400000300f03c60c658',
  '960x540': '6764001facd940f0117ef0110000030001000003003c0f183196',
  '2704x1520': '67640032acd9402a40bfb0110000030001000003003c0f183196',
  '3840x2160': '67640033acd9403c0043ec0440000003004000000f03c60c6580',
  /** High 4:4:4, 1088 rows cropped by 8 in luma units. */
  '1920x1080 4:4:4': '67f40028919b280f0044fc4e0220000003002000000781e30632c0',
  /** Monochrome. */
  '1920x1080 gray': '6764002af36501e0089f89c05b20000003002000000f01e30632c0',
  /** Interlaced: two fields of 544 rows. */
  '1920x1080 fields': '67640028acd94078044fde0220000003002000000783e2c5b2c0',
  /** Constrained Baseline: no chroma format or bit depths. */
  '1920x1080 baseline': '6742c028da01e0089f970110000003001000000303c0f1832a'
}

const HEVC_SPS = {
  '1280x720':
    '42010101600000030090000003000003005da00280802d16595952930bc05a020000030002000003003c10',
  '1280x720@60':
    '420101016000000300900000030000030078a00280802d16595952930bc05a020000030002000003007810',
  /** 1088 rows of 16-sample blocks, the bottom 8 outside the window. */
  '1920x1080':
    '420101016000000300900000030000030078a003c0801107cb965654a4c2f0168080000003008000000f04',
  '2560x1440':
    '420101016000000300900000030000030096a001402005a16595952930bc05a020000003002000000303c1',
  '3840x2160':
    '420101016000000300900000030000030096a001e020021c5965654a4c2f016808000003000800000300f040'
}

const hex = (value: string): Buffer => Buffer.from(value, 'hex')
const size = (width: number, height: number): PictureSize => ({ width, height })

/**
 * A High profile SPS with what libx264 never writes: scaling lists, one that
 * ends early on a zero, and picture order count type 1.
 */
function handMadeSps(): Buffer {
  const out = new BitWriter()
  out.u(8, 100)
  out.u(8, 0)
  out.u(8, 40)
  out.ue(0)
  out.ue(1)
  out.ue(0)
  out.ue(0)
  out.u(1, 0)
  out.u(1, 1)
  for (let i = 0; i < 8; i++) {
    const present = i === 0 || i === 6
    out.u(1, present ? 1 : 0)
    // List 0: sixteen deltas of 0. List 6: a delta of -8 ends it at once.
    if (i === 0) for (let j = 0; j < 16; j++) out.ue(0)
    if (i === 6) out.ue(16)
  }
  out.ue(0)
  out.ue(1)
  out.u(1, 0)
  out.ue(0)
  out.ue(0)
  out.ue(2)
  out.ue(0)
  out.ue(1)
  out.ue(1)
  out.u(1, 0)
  out.ue(79)
  out.ue(44)
  out.u(1, 1)
  out.u(1, 1)
  out.u(1, 0)
  out.u(1, 0)
  out.align()
  return Buffer.concat([Buffer.from([0x67]), toPayload(out.bytes())])
}

describe('the picture size in a sequence parameter set', function () {
  it('reads H.264 sizes, cropped from whole macroblocks', function () {
    for (const [name, sps] of Object.entries(AVC_SPS)) {
      const [width, height] = name.split(/[ @]/)[0].split('x').map(Number)
      expect(avcPictureSize(hex(sps)), name).deep.equals(size(width, height))
    }
  })

  it('reads HEVC sizes, inside the conformance window', function () {
    for (const [name, sps] of Object.entries(HEVC_SPS)) {
      const [width, height] = name.split('@')[0].split('x').map(Number)
      expect(hevcPictureSize(hex(sps)), name).deep.equals(size(width, height))
    }
  })

  it('reads past the emulation prevention bytes', function () {
    // Each of these has a 00 00 03 ahead of its size fields; read as it stands
    // the HEVC one's sizes come out wrong.
    for (const sps of [AVC_SPS['1920x1080'], HEVC_SPS['3840x2160']]) {
      expect(sps.slice(0, 40)).to.include('000003')
    }
    expect(hevcPictureSize(hex(HEVC_SPS['3840x2160']))).deep.equals(
      size(3840, 2160)
    )
  })

  it('reads past scaling lists and picture order count type 1', function () {
    expect(avcPictureSize(handMadeSps())).deep.equals(size(1280, 720))
  })

  it('will not read a unit that is not an SPS', function () {
    expect(() => avcPictureSize(Buffer.from([0x68, 0xce]))).to.throw(
      'not an H.264 SPS'
    )
    expect(() => hevcPictureSize(Buffer.from([34 << 1, 1, 0]))).to.throw(
      'not an HEVC SPS'
    )
  })

  it('takes the size from the first SPS of a decoder configuration record', function () {
    const avcC = avcCRecord([
      hex(AVC_SPS['960x540']),
      Buffer.from([0x68, 0xce])
    ])
    expect(pictureSizeOf('h264', avcC)).deep.equals(size(960, 540))
    const [vps, , pps] = parameterSetNals(1)
    const hvcC = hvcCRecord([vps, hex(HEVC_SPS['2560x1440']), pps])
    expect(pictureSizeOf('hevc', hvcC)).deep.equals(size(2560, 1440))
  })

  it('has no size for a record with no SPS it can read', function () {
    expect(pictureSizeOf('h264', avcCRecord([Buffer.from([0x68, 1])]))).equals(
      undefined
    )
    expect(pictureSizeOf('hevc', hvcCRecord([]))).equals(undefined)
    // A parameter set too short to hold a size.
    expect(pictureSizeOf('hevc', hvcCRecord(parameterSetNals(1)))).equals(
      undefined
    )
    expect(pictureSizeOf('h264', Buffer.from([1, 0x64]))).equals(undefined)
  })
})

describe('the picture sizes TeamStation takes', function () {
  it('takes 720p to 1080p, landscape or portrait', function () {
    for (const [width, height] of [
      [1280, 720],
      [1920, 1080],
      [1080, 1920],
      [1440, 1080]
    ]) {
      expect(sizeAccepted(size(width, height)), `${width}x${height}`).equals(
        true
      )
      expect(sizeRefusal(size(width, height))).equals(null)
    }
  })

  it('refuses smaller and larger pictures, naming their size', function () {
    for (const [width, height] of [
      [960, 540],
      [2560, 1440],
      [3840, 2160],
      [2704, 1520]
    ]) {
      expect(sizeAccepted(size(width, height)), `${width}x${height}`).equals(
        false
      )
      expect(sizeRefusal(size(width, height))).equals(
        `${STREAM_REFUSAL_PREFIXES[2]} This stream is ${width} × ${height} — change the resolution and start it again.`
      )
    }
  })

  it('never asks the frame rate: 720p at 60 fps is taken', function () {
    expect(sizeRefusal(avcPictureSize(hex(AVC_SPS['1280x720@60'])))).equals(
      null
    )
    expect(sizeRefusal(hevcPictureSize(hex(HEVC_SPS['1280x720@60'])))).equals(
      null
    )
  })
})
