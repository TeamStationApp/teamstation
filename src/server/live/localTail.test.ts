import { execFile } from 'node:child_process'
import * as files from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'

import {
  encodeFragmented,
  FFMPEG,
  stampFile,
  writeLive
} from '../../test/wallClockFixtures'
import { ffprobeFor, probeDuration } from '../media/ffmpeg'
import { checkTrackStarts, soundStepProblem } from '../media/trackStarts'
import {
  parseMediaPlaylist,
  type PlaylistSegment,
  readRecordingStamps
} from '../media/wallClockScan'
import { storeWallPoints } from '../media/wallTimeline'
import {
  drainPublishForTest,
  finishStream,
  localTickForTest,
  playlistDuration,
  sync
} from './controller'
import { originFixture } from './originFixtures'
import { isSegmentName } from './originPublish'
import { OriginPublisher } from './originPublisher'
import { resumeScan, scanNewSegments } from './wallAnchors'

const run = promisify(execFile)

/** A recording made ahead of time, which a test lists piece by piece. */
interface Staged {
  dir: string
  header: string[]
  segments: PlaylistSegment[]
}

/**
 * `seconds` of a small test picture in `pieceSec` fMP4 pieces, as the live
 * writer names them. `lateSoundSec` adds sound from then on, stamped from
 * nought, which the close's sound check reports.
 */
async function record(
  dir: string,
  options: { seconds: number; pieceSec: number; lateSoundSec?: number }
): Promise<Staged> {
  await files.mkdir(dir, { recursive: true })
  const late = options.lateSoundSec
  await run(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=160x90:rate=10:duration=${options.seconds}`,
      ...(late == null
        ? []
        : [
            '-f',
            'lavfi',
            '-itsoffset',
            String(late),
            '-i',
            `sine=frequency=1000:sample_rate=48000:duration=${options.seconds - late}`
          ]),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      String(options.pieceSec * 10),
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      ...(late == null ? [] : ['-c:a', 'aac']),
      '-f',
      'hls',
      '-hls_time',
      String(options.pieceSec),
      '-hls_playlist_type',
      'event',
      '-hls_segment_type',
      'fmp4',
      '-hls_fmp4_init_filename',
      'init.mp4',
      '-hls_flags',
      'independent_segments',
      '-hls_segment_filename',
      join(dir, 'seg%06d.m4s'),
      join(dir, 'master.m3u8')
    ],
    { maxBuffer: 1 << 22 }
  )
  return await staged(dir)
}

async function staged(dir: string): Promise<Staged> {
  const text = (await files.readFile(join(dir, 'master.m3u8'), 'utf8')).replace(
    '#EXT-X-ENDLIST\n',
    ''
  )
  await files.writeFile(join(dir, 'master.m3u8'), text)
  const lines = text.split('\n')
  const header = lines.slice(
    0,
    lines.findIndex(line => line.startsWith('#EXTINF:'))
  )
  return { dir, header, segments: parseMediaPlaylist(text).segments }
}

/**
 * The first `count` pieces of a staged recording as the live writer lists
 * them, each dated from `startMs` on, as `program_date_time` dates them.
 */
function listed(source: Staged, count: number, startMs: number): string {
  const lines = [...source.header]
  let at = startMs
  for (const segment of source.segments.slice(0, count)) {
    if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY')
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${ffmpegDate(at)}`)
    lines.push(`#EXTINF:${segment.durationSec.toFixed(6)},`, segment.uri)
    at += segment.durationSec * 1000
  }
  return lines.join('\n') + '\n'
}

/** A date as FFmpeg's `program_date_time` writes it: local, with its offset. */
function ffmpegDate(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}` +
    `${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`
  )
}

function lengthOf(segments: PlaylistSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.durationSec, 0)
}

describe('the ingest keeps only the newest pieces on disk (M4)', function () {
  this.timeout(180000)
  let f: Awaited<ReturnType<typeof originFixture>>
  let fiveMinutes: Staged
  let lateSound: Staged
  let stamped: Staged
  let scratch: string

  before(async function () {
    scratch = await files.mkdtemp(join(tmpdir(), 'tsLocalTail-'))
    fiveMinutes = await record(join(scratch, 'five'), {
      seconds: 300,
      pieceSec: 4
    })
    lateSound = await record(join(scratch, 'late'), {
      seconds: 100,
      pieceSec: 4,
      lateSoundSec: 8
    })
    const plain = join(scratch, 'plain.mp4')
    const stampedFile = join(scratch, 'stamped.mp4')
    await encodeFragmented(plain, { codec: 'hevc', seconds: 30 })
    await stampFile(plain, stampedFile, 1700000000000)
    await files.mkdir(join(scratch, 'stamped'))
    await writeLive(stampedFile, join(scratch, 'stamped'), {})
    stamped = await staged(join(scratch, 'stamped'))
  })
  after(async () => {
    await files.rm(scratch, { recursive: true, force: true })
  })
  beforeEach(async () => {
    f = await originFixture()
  })
  afterEach(async () => {
    await f?.close()
  })

  /** Lists more of `source` in the live directory, piece by piece. */
  async function grow(
    source: Staged,
    count: number,
    startMs: number
  ): Promise<void> {
    await files.mkdir(f.dir, { recursive: true })
    await files.copyFile(join(source.dir, 'init.mp4'), join(f.dir, 'init.mp4'))
    for (const segment of source.segments.slice(0, count)) {
      const path = join(f.dir, segment.uri)
      const copied = join(f.dir, `.${segment.uri}.copied`)
      if (
        (await files.stat(copied).catch(() => undefined)) == null &&
        (await files.stat(path).catch(() => undefined)) == null
      ) {
        await files.copyFile(join(source.dir, segment.uri), path)
        await files.writeFile(copied, '')
      }
    }
    const playlist = join(f.dir, 'master.m3u8')
    await files.writeFile(`${playlist}.tmp`, listed(source, count, startMs))
    await files.rename(`${playlist}.tmp`, playlist)
  }

  /** Ticks until the wall clock scan and the origin have caught up. */
  async function settle(count: number): Promise<void> {
    for (let pass = 0; pass < Math.ceil(count / 8) + 2; pass++) {
      await localTickForTest(f.options)
      await drainPublishForTest(f.videoId)
    }
  }

  async function pieces(): Promise<string[]> {
    return (await files.readdir(f.dir)).filter(isSegmentName).sort()
  }

  async function remoteSize(name: string): Promise<number | undefined> {
    return (await files.stat(join(f.remoteDir, name)).catch(() => undefined))
      ?.size
  }

  async function live(tailSec: number): Promise<void> {
    f.options.live = { ...f.options.live, localTailSec: tailSec }
    await files.mkdir(f.dir, { recursive: true })
    await f.begin()
    await sync(f.options)
  }

  it('keeps the playlist, init.mp4 and at most 64 s of pieces after 5 minutes, with every deleted piece in the Space', async () => {
    await live(60)
    const startMs = Date.now() - 300_000
    for (const count of [15, 30, 45, 60, fiveMinutes.segments.length]) {
      await grow(fiveMinutes, count, startMs)
      await settle(count)
    }
    const left = await pieces()
    // The first piece is the wall clock scan's placement piece, which it
    // reads again on every look, so it stays; the tail is the rest.
    expect(left[0]).equals('seg000000.m4s')
    const kept = fiveMinutes.segments.filter(
      s => left.includes(s.uri) && s.uri !== 'seg000000.m4s'
    )
    expect(lengthOf(kept)).at.most(64)
    expect(kept.at(-1)?.uri).equals(fiveMinutes.segments.at(-1)?.uri)
    const names = await files.readdir(f.dir)
    expect(names).includes('master.m3u8')
    expect(names).includes('init.mp4')
    const deleted = fiveMinutes.segments.filter(s => !left.includes(s.uri))
    expect(deleted.length).at.least(fiveMinutes.segments.length - 18)
    for (const segment of deleted)
      expect(await remoteSize(segment.uri)).equals(
        (await files.stat(join(fiveMinutes.dir, segment.uri))).size
      )
    const body = await f.body()
    expect(parseMediaPlaylist(body).segments.map(s => s.uri)).deep.equals(
      fiveMinutes.segments.map(s => s.uri)
    )
    console.log(
      `on disk after 5 min: ${left.length} pieces, ${lengthOf(kept)} s (${left[0]}…${left.at(-1)}); deleted ${deleted.length}`
    )
  })

  it('never deletes a piece the Space has not acknowledged, and deletes it once it has', async () => {
    await live(20)
    const startMs = Date.now() - 200_000
    await grow(fiveMinutes, 10, startMs)
    await settle(10)
    f.store.faults.set({
      method: 'PUT',
      key: /seg0000(1[0-9]|2[0-9])\.m4s$/,
      status: 503
    })
    await grow(fiveMinutes, 30, startMs)
    await settle(30)
    const failing = await pieces()
    for (let n = 10; n < 30; n++)
      expect(failing).includes(`seg${String(n).padStart(6, '0')}.m4s`)
    expect(failing).not.includes('seg000001.m4s')
    f.store.faults.clear()
    await grow(fiveMinutes, 31, startMs)
    await settle(31)
    const recovered = await pieces()
    expect(recovered).not.includes('seg000010.m4s')
    expect(await remoteSize('seg000010.m4s')).equals(
      (await files.stat(join(fiveMinutes.dir, 'seg000010.m4s'))).size
    )
    console.log(
      `while the Space failed: ${failing[0]}…${failing.at(-1)}; after: ${recovered[0]}…${recovered.at(-1)}`
    )
  })

  it('keeps a piece the wall clock scan has not read until the scan passes it', async () => {
    await live(20)
    const startMs = Date.now() - 200_000
    await grow(fiveMinutes, 40, startMs)
    // Uploaded, but scanned only one batch of eight.
    await drainPublishForTest(f.videoId)
    await localTickForTest(f.options)
    await drainPublishForTest(f.videoId)
    const early = await pieces()
    for (let n = 8; n < 30; n++)
      expect(early).includes(`seg${String(n).padStart(6, '0')}.m4s`)
    expect(early).not.includes('seg000001.m4s')
    await settle(40)
    expect(await pieces()).not.includes('seg000020.m4s')
  })

  it('deletes nothing with localTailSec 0', async () => {
    await live(0)
    await grow(fiveMinutes, 40, Date.now() - 200_000)
    await settle(40)
    expect(await pieces()).length(40)
  })

  it('deletes nothing without a Space, and finishes through the recording', async () => {
    f.options.space = undefined
    await live(20)
    await grow(fiveMinutes, 40, Date.now() - 200_000)
    await settle(40)
    expect(await pieces()).length(40)
    await finishStream(f.options, f.stream.id, 'Finished')
    await drainPublishForTest(f.videoId)
    expect((await f.row())?.storage).equals('local')
    expect((await files.stat(join(f.dir, 'video.mp4'))).isFile()).equals(true)
  })

  it('restarts from the pieces on disk and publishes the same playlist body', async () => {
    await live(20)
    const startMs = Date.now() - 200_000
    await grow(fiveMinutes, 40, startMs)
    await settle(40)
    expect(await pieces()).not.includes('seg000001.m4s')
    const before = await f.body()
    f.requests.length = 0
    const restarted = new OriginPublisher({
      space: f.options.space!,
      videoId: f.videoId,
      spaceSecret: f.spaceSecret,
      dir: f.dir,
      ffmpegPath: f.options.ffmpegPath,
      isFinal: () => true,
      onFirstSegment: async () => {},
      localTailSec: 20,
      scanned: () => ({ segments: 40 })
    })
    const result = await restarted.flush()
    expect(result.body).equals(before)
    expect(restarted.deletedAny).equals(true)
    expect(
      f.requests.filter(r => r.key.endsWith('.m4s') && r.method !== 'HEAD')
    ).deep.equals([])
    await grow(fiveMinutes, 45, startMs)
    const grown = await restarted.flush()
    expect(parseMediaPlaylist(grown.body!).segments).length(45)
    expect(await f.body()).equals(grown.body)
    console.log(
      `restart: ${f.requests.filter(r => r.method === 'PUT').length} PUTs after the restart, body unchanged`
    )
  })

  it('resumes the wall clock scan from the first piece on disk when the newest point’s piece is gone', async () => {
    await live(20)
    const startMs = Date.now() - 200_000
    await grow(fiveMinutes, 40, startMs)
    await settle(40)
    const left = await pieces()
    const first = fiveMinutes.segments.findIndex(
      (s, index) => index > 0 && left.includes(s.uri)
    )
    expect(first).above(5)
    // The newest point stored is in a piece that has gone.
    const ends: number[] = []
    let end = 0
    for (const segment of fiveMinutes.segments) {
      end += segment.durationSec * 1000
      ends.push(end)
    }
    await f.f.h.db
      .deleteFrom('video_wall_anchors')
      .where('video_id', '=', f.videoId)
      .where('media_ms', '>=', Math.round(ends[2]))
      .execute()
    const newest = await f.f.h.db
      .selectFrom('video_wall_anchors')
      .select(eb => eb.fn.max('media_ms').as('ms'))
      .where('video_id', '=', f.videoId)
      .executeTakeFirstOrThrow()
    const cursor = await resumeScan(f.f.h.db, f.videoId, f.dir)
    expect(cursor.segments).equals(first)
    const scanned = await scanNewSegments(f.dir, cursor, Date.now, 100)
    expect(scanned.unreadable).deep.equals([])
    expect(scanned.points.length).equals(40 - first)
    expect(
      scanned.points.every(point => point.mediaMs > Number(newest.ms))
    ).equals(true)
    const count = async (): Promise<number> =>
      (
        await f.f.h.db
          .selectFrom('video_wall_anchors')
          .select('media_ms')
          .where('video_id', '=', f.videoId)
          .execute()
      ).length
    const held = await count()
    await storeWallPoints(f.f.h.db, f.videoId, scanned.points)
    expect(await count()).equals(held + scanned.points.length)
  })

  it('takes the closing poster from the Space and gets the duration from the playlist', async () => {
    await live(60)
    const startMs = Date.now() - 300_000
    for (const count of [30, 60, fiveMinutes.segments.length]) {
      await grow(fiveMinutes, count, startMs)
      await settle(count)
    }
    expect(await pieces()).not.includes('seg000037.m4s')
    const whole = join(fiveMinutes.dir, 'whole.m3u8')
    await files.writeFile(
      whole,
      listed(fiveMinutes, fiveMinutes.segments.length, startMs) +
        '#EXT-X-ENDLIST\n'
    )
    const expected = await probeDuration(ffprobeFor(FFMPEG), whole)
    await finishStream(f.options, f.stream.id, 'Finished')
    await drainPublishForTest(f.videoId)
    const row = await f.row()
    expect(row?.spaces_verified_at).not.equals(null)
    expect(row?.duration_sec).equals(expected)
    expect(await playlistDuration(whole)).equals(expected)
    const stills = (await files.readdir(join(f.oldRemoteDir, 'stills'))).filter(
      name => name.endsWith('.jpg')
    )
    expect(stills).deep.equals(['150.jpg'])
    expect(await files.stat(f.dir).catch(() => undefined)).equals(undefined)
    console.log(
      `tailed close: duration ${row?.duration_sec} s, still ${stills[0]}`
    )
  })

  it('gets the same duration and sound check from a tailed close as from the recording whole on disk', async () => {
    await live(20)
    const startMs = Date.now() - 100_000
    await grow(lateSound, lateSound.segments.length, startMs)
    await settle(lateSound.segments.length)
    expect(await pieces()).not.includes('seg000001.m4s')
    const whole = join(lateSound.dir, 'whole.m3u8')
    await files.writeFile(
      whole,
      listed(lateSound, lateSound.segments.length, startMs) + '#EXT-X-ENDLIST\n'
    )
    const duration = await probeDuration(ffprobeFor(FFMPEG), whole)
    const problem = soundStepProblem(await checkTrackStarts(whole))
    expect(problem).matches(/^sound is stamped/)
    await finishStream(f.options, f.stream.id, 'Finished')
    await drainPublishForTest(f.videoId)
    const row = await f.row()
    expect(row?.duration_sec).equals(duration)
    expect(row?.status_message).equals(problem)
    console.log(`tailed close: ${row?.duration_sec} s, ${row?.status_message}`)
  })

  it('never deletes the scan’s placement piece, and closes with the same anchors as the recording whole on disk', async () => {
    await live(5)
    const count = stamped.segments.length
    const startMs = Date.now() - 60_000
    for (const step of [10, 20, count]) {
      await grow(stamped, Math.min(step, count), startMs)
      await settle(Math.min(step, count))
    }
    const left = await pieces()
    expect(left).includes('seg000000.m4s')
    expect(left).not.includes('seg000001.m4s')
    expect(left).not.includes('seg000010.m4s')
    const expected = await readRecordingStamps(stamped.dir, {
      playlistFile: 'master.m3u8'
    })
    expect(expected.points.length).above(0)
    f.requests.length = 0
    await finishStream(f.options, f.stream.id, 'Finished')
    await drainPublishForTest(f.videoId)
    expect((await f.row())?.spaces_verified_at).not.equals(null)
    const actual = await f.f.h.db
      .selectFrom('video_wall_anchors')
      .selectAll()
      .where('video_id', '=', f.videoId)
      .where('source', '=', 'sei')
      .orderBy('media_ms')
      .execute()
    expect(
      actual.map(a => [a.media_ms, new Date(a.wall).getTime()])
    ).deep.equals(expected.points.map(p => [p.mediaMs, p.wallMs]))
    const read = f.requests.filter(
      r => r.method === 'GET' && r.key.endsWith('seg000001.m4s')
    )
    expect(read.length).at.least(1)
    console.log(
      `stamped close: ${left.length} pieces left before close (${left.join(', ')}), ${actual.length} anchors`
    )
  })

  it('continues a reconnect after deletion with one discontinuity, and publishes every piece from 0', async () => {
    await live(20)
    const startMs = Date.now() - 120_000
    await grow(fiveMinutes, 25, startMs)
    await settle(25)
    expect(await pieces()).not.includes('seg000001.m4s')
    // The publisher comes back: the writer appends to the playlist alone.
    await run(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=10:duration=12',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-g',
        '40',
        '-sc_threshold',
        '0',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'hls',
        '-hls_time',
        '4',
        '-hls_playlist_type',
        'event',
        '-hls_segment_type',
        'fmp4',
        '-hls_fmp4_init_filename',
        'init.mp4',
        '-hls_flags',
        'independent_segments+temp_file+program_date_time+omit_endlist+append_list',
        '-start_number',
        '0',
        '-hls_segment_filename',
        join(f.dir, 'seg%06d.m4s'),
        join(f.dir, 'master.m3u8')
      ],
      { maxBuffer: 1 << 22 }
    )
    const local = await files.readFile(join(f.dir, 'master.m3u8'), 'utf8')
    const segments = parseMediaPlaylist(local).segments
    expect(segments.length).at.least(27)
    expect(segments[25].uri).equals('seg000025.m4s')
    expect(segments.filter(s => s.discontinuity)).length(1)
    expect(segments[25].discontinuity).equals(true)
    await settle(segments.length)
    const body = await f.body()
    const published = parseMediaPlaylist(body).segments
    expect(published.map(s => s.uri)).deep.equals(segments.map(s => s.uri))
    expect(published[0].uri).equals('seg000000.m4s')
    expect(body.match(/#EXT-X-DISCONTINUITY/g)).length(1)
    for (const segment of segments)
      expect(await remoteSize(segment.uri)).above(0)
    console.log(
      `reconnect after deletion: ${segments.length} pieces listed, the new run from ${segments[25].uri}; on disk ${(await pieces()).join(', ')}`
    )
  })
})
