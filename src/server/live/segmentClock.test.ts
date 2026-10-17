import { expect } from 'chai'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { describe, it } from 'mocha'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  hevcInit,
  hevcSegment,
  IDR_SLICE,
  wallClockNal
} from './frameWallFixture'
import {
  LEADING_BOX_BYTES,
  listedTimelineEndSec,
  moveSegmentOnTimeline,
  placeSegmentOnTimeline,
  readFrameWall,
  readLeadingBoxes,
  readLeadingBoxesSync,
  recoverUnstampedSegments,
  restampSegments,
  stampNewSegments,
  timelineStartSec
} from './segmentClock'

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(payload.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

function track(id: number, timescale: number, handler: string): Buffer {
  const tkhd = Buffer.alloc(16)
  tkhd.writeUInt32BE(id, 12)
  const mdhd = Buffer.alloc(16)
  mdhd.writeUInt32BE(timescale, 12)
  const hdlr = Buffer.alloc(12)
  hdlr.write(handler, 8, 'latin1')
  return box(
    'trak',
    Buffer.concat([
      box('tkhd', tkhd),
      box('mdia', Buffer.concat([box('mdhd', mdhd), box('hdlr', hdlr)]))
    ])
  )
}

function sidx(version: number, timescale: number, earliest: bigint): Buffer {
  const payload = version === 1 ? Buffer.alloc(32) : Buffer.alloc(24)
  payload[0] = version
  payload.writeUInt32BE(timescale, 8)
  if (version === 1) payload.writeBigUInt64BE(earliest, 12)
  else payload.writeUInt32BE(Number(earliest), 12)
  return box('sidx', payload)
}

function fragment(trackId: number, version: number, base: bigint): Buffer {
  const tfhd = Buffer.alloc(8)
  tfhd.writeUInt32BE(trackId, 4)
  const tfdt = Buffer.alloc(version === 1 ? 12 : 8)
  tfdt[0] = version
  if (version === 1) tfdt.writeBigUInt64BE(base, 4)
  else tfdt.writeUInt32BE(Number(base), 4)
  return box(
    'moof',
    box('traf', Buffer.concat([box('tfhd', tfhd), box('tfdt', tfdt)]))
  )
}

const init = Buffer.concat([
  box('ftyp', Buffer.alloc(8)),
  box('moov', Buffer.concat([track(1, 1000, 'vide'), track(2, 48000, 'soun')]))
])

describe('placing a returned segment on the programme clock', function () {
  it('moves each track by the offset and leaves the init segment alone', function () {
    const segment = Buffer.concat([
      sidx(1, 1000, 5n),
      sidx(0, 48000, 100n),
      fragment(1, 1, 0n),
      fragment(2, 0, 100n)
    ])
    const initBefore = Buffer.from(init)
    const moved = placeSegmentOnTimeline(init, segment, 30)
    expect(moved).not.equals(undefined)
    expect(init.equals(initBefore)).equals(true)
    const videoSidx = moved!.indexOf('sidx')
    expect(moved!.readBigUInt64BE(videoSidx + 16)).equals(5n + 30_000n)
    const audioSidx = moved!.indexOf('sidx', videoSidx + 4)
    expect(moved!.readUInt32BE(audioSidx + 16)).equals(100 + 30 * 48000)
    const videoTfdt = moved!.indexOf('tfdt')
    expect(moved!.readBigUInt64BE(videoTfdt + 8)).equals(30_000n)
    const audioTfdt = moved!.indexOf('tfdt', videoTfdt + 4)
    expect(moved!.readUInt32BE(audioTfdt + 8)).equals(100 + 30 * 48000)
  })

  it('does not rewrite a segment that is still incomplete', function () {
    const truncated = Buffer.alloc(8)
    truncated.writeUInt32BE(100, 0)
    truncated.write('sidx', 4, 'latin1')
    expect(placeSegmentOnTimeline(init, truncated, 30)).equals(undefined)
  })

  it('stamps only the segments a restart added', function () {
    const dir = mkdtempSync(join(tmpdir(), 'ts-segment-clock-'))
    try {
      const prior = Buffer.concat([sidx(0, 1000, 0n), fragment(1, 0, 0n)])
      const added = Buffer.concat([sidx(0, 1000, 0n), fragment(1, 0, 0n)])
      writeFileSync(join(dir, 'init.mp4'), init)
      writeFileSync(join(dir, 'seg000000.m4s'), prior)
      writeFileSync(join(dir, 'seg000001.m4s'), added)
      const moved = stampNewSegments(dir, 12, new Set(['seg000000.m4s']))
      expect(moved).deep.equals(['seg000001.m4s'])
      expect(readFileSync(join(dir, 'seg000000.m4s')).equals(prior)).equals(
        true
      )
      const next = readFileSync(join(dir, 'seg000001.m4s'))
      const at = next.indexOf('tfdt')
      expect(next.readUInt32BE(at + 8)).equals(12_000)
      expect(
        stampNewSegments(dir, 12, new Set(['seg000000.m4s', ...moved]))
      ).deep.equals([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a segment start from its leading boxes', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'ts-segment-clock-'))
    try {
      const segment = Buffer.concat([
        sidx(0, 1000, 4_000n),
        fragment(1, 0, 4_000n),
        Buffer.alloc(LEADING_BOX_BYTES * 2)
      ])
      const path = join(dir, 'seg000000.m4s')
      writeFileSync(path, segment)
      const leading = await readLeadingBoxes(path)
      expect(leading.length).equals(LEADING_BOX_BYTES)
      expect(leading.length).lessThan(segment.length)
      expect(timelineStartSec(init, leading)).closeTo(4, 0.001)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stamps a segment left at the publisher zero when the continuation is past the media', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'ts-segment-clock-'))
    try {
      writeFileSync(join(dir, 'init.mp4'), init)
      writeFileSync(
        join(dir, 'seg000000.m4s'),
        Buffer.concat([sidx(0, 1000, 0n), fragment(1, 0, 0n)])
      )
      const left = Buffer.concat([sidx(0, 1000, 66n), fragment(1, 0, 0n)])
      const later = Buffer.concat([sidx(0, 1000, 4066n), fragment(1, 0, 4000n)])
      writeFileSync(join(dir, 'seg000001.m4s'), left)
      writeFileSync(join(dir, 'seg000002.m4s'), later)
      const first = readFileSync(join(dir, 'seg000000.m4s'))
      const playlist = [
        '#EXTM3U',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:00.000Z',
        '#EXTINF:4.000000,',
        'seg000000.m4s',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:30.000Z',
        '#EXTINF:4.000000,',
        'seg000001.m4s',
        '#EXTINF:4.000000,',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:34.000Z',
        'seg000002.m4s',
        ''
      ].join('\n')
      const moved = await recoverUnstampedSegments(dir, playlist, 38)
      expect(moved).deep.equals(['seg000001.m4s', 'seg000002.m4s'])
      expect(readFileSync(join(dir, 'seg000000.m4s')).equals(first)).equals(
        true
      )
      expect(readFileSync(join(dir, 'init.mp4')).equals(init)).equals(true)
      const initBytes = readFileSync(join(dir, 'init.mp4'))
      expect(
        timelineStartSec(initBytes, readFileSync(join(dir, 'seg000001.m4s')))
      ).closeTo(30, 0.001)
      expect(
        timelineStartSec(initBytes, readFileSync(join(dir, 'seg000002.m4s')))
      ).closeTo(34, 0.001)
      expect(await recoverUnstampedSegments(dir, playlist, 38)).deep.equals([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a segment already moved onto its programme date', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'ts-segment-clock-'))
    try {
      const placed = Buffer.concat([
        sidx(0, 1000, 30066n),
        fragment(1, 0, 30000n)
      ])
      writeFileSync(join(dir, 'init.mp4'), init)
      writeFileSync(
        join(dir, 'seg000000.m4s'),
        Buffer.concat([sidx(0, 1000, 66n), fragment(1, 0, 0n)])
      )
      writeFileSync(join(dir, 'seg000001.m4s'), placed)
      const playlist = [
        '#EXTM3U',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:00.000Z',
        '#EXTINF:4.000000,',
        'seg000000.m4s',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:30.000Z',
        '#EXTINF:4.000000,',
        'seg000001.m4s',
        ''
      ].join('\n')
      expect(await recoverUnstampedSegments(dir, playlist, 34)).deep.equals([])
      expect(readFileSync(join(dir, 'seg000001.m4s')).equals(placed)).equals(
        true
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves the first part at the publisher zero, where it belongs', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'ts-segment-clock-'))
    try {
      const opening = Buffer.concat([sidx(0, 1000, 66n), fragment(1, 0, 0n)])
      writeFileSync(join(dir, 'init.mp4'), init)
      writeFileSync(join(dir, 'seg000000.m4s'), opening)
      const playlist = [
        '#EXTM3U',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:00.000Z',
        '#EXTINF:4.000000,',
        'seg000000.m4s',
        ''
      ].join('\n')
      expect(await recoverUnstampedSegments(dir, playlist, 30)).deep.equals([])
      expect(readFileSync(join(dir, 'seg000000.m4s')).equals(opening)).equals(
        true
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stamps a short return that is still at the publisher zero', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'ts-segment-clock-'))
    try {
      writeFileSync(join(dir, 'init.mp4'), init)
      writeFileSync(
        join(dir, 'seg000000.m4s'),
        Buffer.concat([sidx(0, 1000, 0n), fragment(1, 0, 0n)])
      )
      writeFileSync(
        join(dir, 'seg000001.m4s'),
        Buffer.concat([sidx(0, 1000, 0n), fragment(1, 0, 0n)])
      )
      const playlist = [
        '#EXTM3U',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:00.000Z',
        '#EXTINF:0.500000,',
        'seg000000.m4s',
        '#EXT-X-PROGRAM-DATE-TIME:2026-10-14T16:00:00.800Z',
        '#EXTINF:0.500000,',
        'seg000001.m4s',
        ''
      ].join('\n')
      expect(await recoverUnstampedSegments(dir, playlist, 1.3)).deep.equals([
        'seg000001.m4s'
      ])
      expect(
        timelineStartSec(
          readFileSync(join(dir, 'init.mp4')),
          readFileSync(join(dir, 'seg000001.m4s'))
        )
      ).closeTo(0.8, 0.001)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the wall clock a segment carries', function () {
  const captured = 1_790_000_000_123

  it('reads the first picture’s wall clock and its place in the segment', function () {
    const nal = wallClockNal(captured)
    // The wall's zeros are escaped in the NAL, as an encoder writes them.
    expect(nal.includes(Buffer.from([0, 0, 3]))).equals(true)
    const found = readFrameWall(
      hevcInit(),
      hevcSegment(12, [nal, IDR_SLICE], { compositionSec: 0.5 })
    )
    expect(found?.capturedAtMs).equals(captured)
    expect(found?.pictureSec).closeTo(12.5, 1e-9)
  })

  it('finds nothing from a publisher that sends none, or one on its own clock', function () {
    expect(readFrameWall(hevcInit(), hevcSegment(4, [IDR_SLICE]))).equals(
      undefined
    )
    // The corrected bit clear: the publisher had not measured the server's clock.
    expect(
      readFrameWall(
        hevcInit(),
        hevcSegment(4, [wallClockNal(captured, false), IDR_SLICE])
      )
    ).equals(undefined)
    // An SEI after the picture belongs to no frame.
    expect(
      readFrameWall(
        hevcInit(),
        hevcSegment(4, [IDR_SLICE, wallClockNal(captured)])
      )
    ).equals(undefined)
    expect(readFrameWall(hevcInit(), Buffer.alloc(40))).equals(undefined)
    expect(readFrameWall(Buffer.alloc(40), hevcSegment(4, [IDR_SLICE]))).equals(
      undefined
    )
  })

  it('reads it from the opening bytes alone, behind a large picture', function () {
    const big = Buffer.concat([IDR_SLICE, Buffer.alloc(300_000, 0x55)])
    const dir = mkdtempSync(join(tmpdir(), 'ts-frame-wall-'))
    try {
      writeFileSync(
        join(dir, 'seg000001.m4s'),
        hevcSegment(0, [wallClockNal(captured), big])
      )
      const found = readFrameWall(
        hevcInit(),
        readLeadingBoxesSync(join(dir, 'seg000001.m4s'))
      )
      expect(found?.capturedAtMs).equals(captured)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('moving a segment already placed', function () {
  it('moves it back as exactly as forward, and never before zero', function () {
    const segment = Buffer.concat([
      sidx(1, 1000, 5n),
      fragment(1, 1, 0n),
      fragment(2, 0, 100n)
    ])
    const placed = placeSegmentOnTimeline(init, segment, 30.7)!
    const back = moveSegmentOnTimeline(init, placed, 30.7, 30)!
    expect(back.equals(placeSegmentOnTimeline(init, segment, 30)!)).equals(true)
    expect(() => moveSegmentOnTimeline(init, placed, 30.7, -1)).throws(
      /before zero/
    )
  })

  it('restamps only the segments it is given', function () {
    const dir = mkdtempSync(join(tmpdir(), 'ts-restamp-'))
    try {
      writeFileSync(join(dir, 'init.mp4'), init)
      const segment = Buffer.concat([sidx(1, 1000, 0n), fragment(1, 1, 0n)])
      const listed = placeSegmentOnTimeline(init, segment, 10)!
      writeFileSync(join(dir, 'seg000000.m4s'), listed)
      writeFileSync(
        join(dir, 'seg000001.m4s'),
        placeSegmentOnTimeline(init, segment, 40)!
      )
      expect(
        restampSegments(dir, ['seg000001.m4s', 'gone.m4s'], 40, 40.7)
      ).deep.equals(['seg000001.m4s'])
      const start = (name: string): number | undefined =>
        timelineStartSec(init, readFileSync(join(dir, name)))
      expect(start('seg000001.m4s')).closeTo(40.7, 1e-9)
      expect(readFileSync(join(dir, 'seg000000.m4s')).equals(listed)).equals(
        true
      )
      expect(restampSegments(dir, ['seg000001.m4s'], 40.7, 40.7)).deep.equals(
        []
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds where the listed timeline ends from the last segment’s own stamp', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'ts-listed-end-'))
    try {
      writeFileSync(join(dir, 'init.mp4'), init)
      const segment = Buffer.concat([sidx(1, 1000, 0n), fragment(1, 1, 0n)])
      writeFileSync(
        join(dir, 'seg000003.m4s'),
        placeSegmentOnTimeline(init, segment, 42.5)!
      )
      const playlist = [
        '#EXTM3U',
        '#EXTINF:4.000000,',
        'seg000002.m4s',
        '#EXTINF:3.960000,',
        'seg000003.m4s',
        ''
      ].join('\n')
      expect(await listedTimelineEndSec(dir, playlist)).closeTo(46.46, 1e-9)
      expect(await listedTimelineEndSec(dir, '#EXTM3U\n')).equals(undefined)
      expect(await listedTimelineEndSec(dir, undefined)).equals(undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
