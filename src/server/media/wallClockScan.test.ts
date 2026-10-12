import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { wallAt } from '../../common/wallTimeline'
import { addGame, addTeam, scratchDatabase } from '../../test/scoreboardKit'
import {
  canEncode,
  encodeFragmented,
  FFMPEG,
  stampFile
} from '../../test/wallClockFixtures'
import type { Database } from '../db/database'
import { remuxToHls } from './ffmpeg'
import { ingestVideoFile } from './ingestFile'
import {
  parseMediaPlaylist,
  readBoxes,
  type ScannedFrame,
  scanRecording,
  scanSegment,
  thinStamps,
  videoTrackOf
} from './wallClockScan'
import { readWallTimeline } from './wallTimeline'

const run = promisify(execFile)
const START = 1_700_000_000_000
/** A whole file as the first segment of its playlist. */
const PLACE = { startMs: 0, durationMs: 3000, discontinuity: false }

/** Each video frame's presentation time in ms, as FFmpeg reads it. */
async function framePts(file: string): Promise<number[]> {
  const { stdout } = await run(FFMPEG.replace(/ffmpeg$/, 'ffprobe'), [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=pts_time',
    '-of',
    'csv=p=0',
    file
  ])
  return stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => Math.round(Number.parseFloat(line) * 1000))
}

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

/** U23: the scanner on stamped fixtures, through real FFmpeg. */
describe('reading the wall clock out of fMP4 (U23)', function () {
  this.timeout(120_000)
  let dir = ''

  before(async function () {
    if (!(await canEncode('libx265', 'libx264', 'aac'))) this.skip()
    dir = await mkdtemp(join(tmpdir(), 'tsWallScan-'))
    // HEVC with B-frames and sound: the first frame presents two frames after
    // it decodes, and the sound shares every fragment.
    await encodeFragmented(join(dir, 'hevc.mp4'), {
      codec: 'hevc',
      seconds: 3,
      bframes: 3,
      sound: true
    })
    await stampFile(join(dir, 'hevc.mp4'), join(dir, 'hevcStamped.mp4'), START)
    // And a camera's picture alone, without B-frames, which a remux copies
    // frame for frame. (FFmpeg's HLS muxer rewrites a presentation time at
    // the cut of an open GOP, and stretches the first frame by the sound's
    // priming; the points would show either, as a player does.)
    await encodeFragmented(join(dir, 'camera.mp4'), {
      codec: 'hevc',
      seconds: 3
    })
    await stampFile(
      join(dir, 'camera.mp4'),
      join(dir, 'cameraStamped.mp4'),
      START
    )
    await encodeFragmented(join(dir, 'h264.mp4'), {
      codec: 'h264',
      seconds: 2,
      bframes: 2
    })
    await stampFile(
      join(dir, 'h264.mp4'),
      join(dir, 'h264Stamped.mp4'),
      START,
      false
    )
  })

  after(async function () {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  it('reads the track an init segment describes', async function () {
    const hevc = videoTrackOf(await readFile(join(dir, 'hevc.mp4')))
    expect(hevc).to.include({ codec: 'hevc', lengthSize: 4, trackId: 1 })
    expect(hevc?.timescale).greaterThan(0)
    const h264 = videoTrackOf(await readFile(join(dir, 'h264.mp4')))
    expect(h264).to.include({ codec: 'h264', lengthSize: 4 })
    // No `moov`, or nothing in it that is a picture.
    expect(videoTrackOf(new Uint8Array(16))).equals(null)
  })

  it('gives every frame its stamp, at its presentation time with B-frames', async function () {
    const file = join(dir, 'hevcStamped.mp4')
    const bytes = await readFile(file)
    const track = videoTrackOf(bytes)!
    const scanned = scanSegment(bytes, track, PLACE).frames
    const pts = await framePts(file)
    expect(scanned.length).equals(90)
    expect(pts.length).equals(90)
    // B-frames: the first picture presents after zero, and the stamp is the
    // start plus each frame's own presentation time, in presentation order.
    expect(pts[0]).greaterThan(0)
    for (const [i, frame] of scanned.entries()) {
      expect(frame.stamp?.wallMs, `frame ${i}`).within(
        START + pts[i] - 1,
        START + pts[i] + 1
      )
      expect(frame.stamp?.corrected).equals(true)
      // Media time runs from the segment's first decode, which is zero.
      expect(frame.mediaMs).within(pts[i] - 1, pts[i] + 1)
    }
  })

  it('carries the corrected bit, and reads H.264 too', async function () {
    const bytes = await readFile(join(dir, 'h264Stamped.mp4'))
    const scanned = scanSegment(bytes, videoTrackOf(bytes)!, PLACE).frames
    expect(scanned.length).equals(60)
    expect(scanned.every(frame => frame.stamp?.corrected === false)).equals(
      true
    )
  })

  it('finds nothing of ours in an unstamped file, whose encoder writes its own user data', async function () {
    const bytes = await readFile(join(dir, 'hevc.mp4'))
    const scanned = scanSegment(bytes, videoTrackOf(bytes)!, PLACE).frames
    expect(scanned.length).equals(90)
    expect(scanned.every(frame => frame.stamp == null)).equals(true)
  })

  it('places points on the playlist of the recording a remux makes', async function () {
    const out = join(dir, 'remux')
    await mkdir(out)
    await remuxToHls(FFMPEG, {
      input: join(dir, 'cameraStamped.mp4'),
      outDir: out,
      segmentSeconds: 1
    })
    const playlist = parseMediaPlaylist(
      await readFile(join(out, 'video.m3u8'), 'utf8')
    )
    expect(playlist.segments.length).greaterThan(1)
    const points = await scanRecording(out)
    const pts = await framePts(join(dir, 'cameraStamped.mp4'))
    // Nothing moves at a segment's edge: a point every half second.
    expect(points.map(point => point.mediaMs)).deep.equals([
      0, 500, 1000, 1500, 2000, 2500
    ])
    // One timeline: every frame of the file maps to its own stamp through
    // the points, across the segments.
    for (const at of pts) {
      expect(
        wallAt(
          points.map(point => [point.mediaMs, point.wallMs]),
          at - pts[0]
        )
      ).within(START + at - 2, START + at + 2)
    }
  })

  it('has no points for a recording with no stamps', async function () {
    const out = join(dir, 'plain')
    await mkdir(out)
    await remuxToHls(FFMPEG, { input: join(dir, 'hevc.mp4'), outDir: out })
    expect(await scanRecording(out)).deep.equals([])
  })
})

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

/** An upload's remux is scanned, and its points stored with the video. */
describe('the wall clock of an upload', function () {
  this.timeout(120_000)
  let db: Kysely<Database>
  let drop: (() => Promise<void>) | undefined
  let space: Server | undefined
  let dir = ''
  let gameId = ''
  let endpoint = ''

  before(async function () {
    if (!(await canEncode('libx265'))) this.skip()
    dir = await mkdtemp(join(tmpdir(), 'tsWallIngest-'))
    await encodeFragmented(join(dir, 'take.mp4'), { codec: 'hevc', seconds: 2 })
    await stampFile(join(dir, 'take.mp4'), join(dir, 'stamped.mp4'), START)
    ;({ db, drop } = await scratchDatabase('wall_ingest'))
    gameId = await addGame(db, {
      homeTeamId: await addTeam(db, 'Pioneers'),
      awayTeamId: await addTeam(db, 'Visitors'),
      startAt: new Date(START)
    })
    const held = new Map<string, Buffer>()
    space = createServer((req, res) => {
      const key = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(chunk as Buffer))
        req.on('end', () => {
          held.set(key, Buffer.concat(chunks))
          res.writeHead(200).end()
        })
        return
      }
      const body = held.get(key)
      if (body == null) {
        res.writeHead(404).end()
        return
      }
      if (req.headers.range != null) {
        res
          .writeHead(206, {
            'content-range': `bytes 0-0/${body.length}`,
            'content-length': '1'
          })
          .end(body.subarray(0, 1))
        return
      }
      res.writeHead(200, { 'content-length': String(body.length) }).end(body)
    })
    await new Promise<void>(resolve => space?.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${(space.address() as AddressInfo).port}`
  })

  after(async function () {
    space?.close()
    await drop?.()
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  async function ingest(file: string): Promise<string> {
    const { videoId } = await ingestVideoFile({
      db,
      space: {
        endpoint,
        region: 'sfo3',
        bucket: 'teamstation',
        accessKeyId: 'AKIAEXAMPLE000000000',
        secretAccessKey: 'secret',
        pathStyle: true
      },
      ffmpegPath: FFMPEG,
      file,
      gameId,
      kind: 'program',
      title: 'Programme',
      startAt: new Date(START),
      startAtSource: 'distributor'
    })
    return videoId
  }

  it('stores the frames’ own points, and none for a take without them', async function () {
    const stamped = await ingest(join(dir, 'stamped.mp4'))
    const video = {
      id: stamped,
      status: 'ready',
      startAt: new Date(START),
      syncOffsetSec: 0,
      clockOffsetMs: null
    }
    const timeline = await readWallTimeline(db, video)
    expect(timeline.source).equals('sei')
    expect(timeline.confidence).equals('frame')
    expect(timeline.anchors.map(([mediaMs]) => mediaMs)).deep.equals([
      0, 500, 1000, 1500
    ])
    expect(timeline.anchors[0][1]).equals(START)

    const plain = await ingest(join(dir, 'take.mp4'))
    const rows = await db
      .selectFrom('video_wall_anchors')
      .select('media_ms')
      .where('video_id', '=', plain)
      .execute()
    expect(rows).deep.equals([])
  })
})
