import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  type Box,
  MalformedBox,
  parseMediaPlaylist,
  readBoxes,
  readTfhd,
  readTrun,
  type ScannedFrame,
  thinStamps
} from './wallClockScan'

const START = 1_700_000_000_000

/** Frames at 30 a second from `fromMs`, each stamped `offset` from 1×. */
function frames(
  count: number,
  wallAtZero: number,
  fromMs = 0,
  offsets: Record<number, number> = {}
): ScannedFrame[] {
  return Array.from({ length: count }, (_, i) => {
    const mediaMs = fromMs + Math.round((i * 1000) / 30)
    return {
      mediaMs,
      stamp: {
        wallMs: wallAtZero + mediaMs + (offsets[i] ?? 0),
        corrected: true
      }
    }
  })
}

/** U24: which stamps become points. */
describe('thinning the stamps (U24)', function () {
  it('keeps the first frame and one every 500 ms', function () {
    const kept = thinStamps(frames(60, START))
    expect(kept.map(point => point.mediaMs)).deep.equals([0, 500, 1000, 1500])
    expect(kept[1]).deep.equals({
      mediaMs: 500,
      wallMs: START + 500,
      corrected: true
    })
  })

  it('keeps a frame more than 20 ms from 1×, and the next one back', function () {
    // Frame 5 is 25 ms late, frame 6 back on time; frame 9 only 15 ms off.
    const kept = thinStamps(frames(20, START, 0, { 5: 25, 9: 15 }))
    expect(kept.map(point => point.mediaMs)).deep.equals([0, 167, 200])
    expect(kept[1].wallMs).equals(START + 167 + 25)
  })

  it('keeps a jump the size of an outage', function () {
    const before = frames(15, START)
    const after = frames(15, START + 20_000, 500)
    const kept = thinStamps([...before, ...after])
    expect(
      kept.map(point => [point.mediaMs, point.wallMs - START])
    ).deep.equals([
      [0, 0],
      [500, 20_500]
    ])
  })

  it('keeps no frame whose wall is not a time of this century', function () {
    const odd: ScannedFrame[] = [
      { mediaMs: 0, stamp: { wallMs: 2 ** 62, corrected: true } },
      { mediaMs: 33, stamp: { wallMs: Number.NaN, corrected: true } },
      ...frames(30, START, 67)
    ]
    expect(thinStamps(odd).map(point => point.mediaMs)).deep.equals([67, 567])
  })

  it('carries on from the last point, and skips frames without a stamp or behind it', function () {
    const last = { mediaMs: 900, wallMs: START + 900, corrected: true }
    const more: ScannedFrame[] = [
      { mediaMs: 900, stamp: { wallMs: START, corrected: true } },
      { mediaMs: 1000, stamp: null },
      ...frames(30, START, 1000)
    ]
    expect(thinStamps(more, last).map(point => point.mediaMs)).deep.equals([
      1400, 1900
    ])
  })
})

describe('reading the boxes and the playlists', function () {
  /** A box of `type` holding `body`, and where it lies. */
  function box(type: string, body: number[]): [Uint8Array, Box] {
    const bytes = Uint8Array.from([
      0,
      0,
      0,
      8 + body.length,
      ...Buffer.from(type, 'latin1'),
      ...body
    ])
    return [bytes, readBoxes(bytes, 0, bytes.length)[0]]
  }

  it('reads no field past the end of its box', function () {
    // A header that says a base offset follows, and holds none.
    const [tfhd, tfhdBox] = box('tfhd', [0, 0, 0, 1, 0, 0, 0, 1])
    expect(() => readTfhd(tfhd, tfhdBox)).throws(MalformedBox, /tfhd/)
    expect(readTfhd(...box('tfhd', [0, 0, 0, 0, 0, 0, 0, 7]))).deep.equals({
      flags: 0,
      trackId: 7
    })
    // A run of two samples with a duration each, that holds one; and one
    // too short for its own count.
    const [trun, trunBox] = box('trun', [0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 9])
    expect(() => readTrun(trun, trunBox)).throws(MalformedBox, /trun/)
    expect(() => readTrun(...box('trun', [0, 0, 0, 0]))).throws(MalformedBox)
    expect(
      readTrun(...box('trun', [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 9])).samples
    ).deep.equals([{ duration: 9 }])
    // A run with no field per sample is believed only so far.
    expect(() =>
      readTrun(...box('trun', [0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]))
    ).throws(MalformedBox)
  })

  it('reads a large size, a box to the end, and stops at a short one', function () {
    const large = new Uint8Array(24)
    const view = new DataView(large.buffer)
    view.setUint32(0, 1)
    large.set([0x66, 0x72, 0x65, 0x65], 4)
    view.setBigUint64(8, 24n)
    expect(readBoxes(large, 0, 24)).deep.equals([
      { type: 'free', start: 0, body: 16, end: 24 }
    ])
    const toEnd = new Uint8Array(12)
    toEnd.set([0x6d, 0x64, 0x61, 0x74], 4)
    expect(readBoxes(toEnd, 0, 12)[0].end).equals(12)
    const short = new Uint8Array(12)
    new DataView(short.buffer).setUint32(0, 4)
    expect(readBoxes(short, 0, 12)).deep.equals([])
    expect(readBoxes(large, 0, 12)).deep.equals([])
  })

  it('reads a live playlist and a byte-range one', function () {
    const live = parseMediaPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:4.000000,',
        'seg000000.m4s',
        '#EXT-X-DISCONTINUITY',
        '#EXTINF:3.500000,',
        'seg000001.m4s',
        ''
      ].join('\n')
    )
    expect(live).deep.equals({
      map: { uri: 'init.mp4' },
      ended: false,
      segments: [
        { uri: 'seg000000.m4s', durationSec: 4, discontinuity: false },
        { uri: 'seg000001.m4s', durationSec: 3.5, discontinuity: true }
      ]
    })
    const vod = parseMediaPlaylist(
      [
        '#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@0"',
        '#EXTINF:6.0,',
        '#EXT-X-BYTERANGE:500@100',
        'video.mp4',
        '#EXTINF:2.0,',
        '#EXT-X-BYTERANGE:300',
        'video.mp4',
        '#EXT-X-ENDLIST'
      ].join('\n')
    )
    expect(vod.map?.range).deep.equals({ offset: 0, length: 100 })
    expect(vod.segments.map(segment => segment.range)).deep.equals([
      { offset: 100, length: 500 },
      { offset: 600, length: 300 }
    ])
    expect(vod.ended).equals(true)
  })
})
