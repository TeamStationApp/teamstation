import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  canEncode,
  encodeFragmented,
  FFMPEG,
  stampFile,
  writeLive
} from '../../test/wallClockFixtures'
import { covers } from '../director/uploads'
import { ffprobeFor, KEEP_STREAM_TIMES, probeDuration } from '../media/ffmpeg'
import { readLocalFrame } from '../media/spaceFrames'
import { checkTrackStarts } from '../media/trackStarts'
import {
  parseMediaPlaylist,
  readPart,
  readRecordingStamps
} from '../media/wallClockScan'
import {
  combinedMaster,
  configurationRuns,
  joinMediaPlaylists,
  recordingSpanSec,
  shiftByteRanges,
  toRecording,
  type VodResult
} from './finishVideo'
import {
  box,
  hevcInit,
  hevcSegment,
  IDR_SLICE,
  wallClockNal
} from './frameWallFixture'
import {
  listedSegments,
  placeSegmentOnTimeline,
  writeStamped
} from './segmentClock'
import { absorbWriterPlaylist, WRITER_PLAYLIST_NAME } from './splitter'
import { scanNewSegments } from './wallAnchors'

const run = promisify(execFile)
const START_MS = 1_790_000_000_000

/** What FFmpeg has to say decoding a file to nothing. */
async function decodeErrors(path: string): Promise<string> {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner',
    '-v',
    'error',
    '-i',
    path,
    '-f',
    'null',
    '-'
  ])
  return stderr
}

/**
 * The same for a file with a filled gap. The picture before one is under a frame
 * long, which the null muxer's frame clock rounds onto the next and says so; no
 * picture is lost to that. `-xerror` makes a real decoding error fail the run.
 */
async function decodeErrorsAcrossGap(path: string): Promise<string[]> {
  const { stderr } = await run(FFMPEG, [
    '-hide_banner',
    '-v',
    'error',
    '-xerror',
    '-i',
    path,
    '-f',
    'null',
    '-'
  ])
  return stderr
    .split('\n')
    .filter(line => line !== '' && !line.includes('non monotonically'))
}

async function videoSize(path: string): Promise<string> {
  const { stdout } = await run(ffprobeFor(FFMPEG), [
    '-v',
    'error',
    '-select_streams',
    'v',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    path
  ])
  return stdout.trim()
}

/** A writer of its own, as the splitter runs one for a changed configuration. */
async function writeOwn(
  input: string,
  dir: string,
  initName: string,
  startNumber: number
): Promise<void> {
  await run(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    input,
    '-c',
    'copy',
    '-tag:v',
    'hvc1',
    '-f',
    'hls',
    '-hls_time',
    '1',
    '-hls_playlist_type',
    'event',
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    initName,
    '-hls_flags',
    'independent_segments+temp_file+program_date_time+omit_endlist',
    '-start_number',
    String(startNumber),
    '-hls_segment_filename',
    join(dir, 'seg%06d.m4s'),
    join(dir, WRITER_PLAYLIST_NAME)
  ])
  absorbWriterPlaylist(dir)
}

describe('a recording that changed configuration part way', function () {
  this.timeout(120_000)
  let root: string
  let dir: string

  before(async function () {
    if (!(await canEncode('libx265', 'aac'))) this.skip()
    root = await mkdtemp(join(tmpdir(), 'tsMismatchedFinish-'))
    dir = join(root, 'video')
    await mkdir(dir)
    const small = join(root, 'small.mp4')
    const large = join(root, 'large.mp4')
    const stamped = join(root, 'stamped.mp4')
    await encodeFragmented(small, { codec: 'hevc', seconds: 3, sound: true })
    await encodeFragmented(large, {
      codec: 'hevc',
      seconds: 3,
      size: '320x240',
      sound: true
    })
    await stampFile(large, stamped, START_MS)
    await writeLive(small, dir, {})
    await writeOwn(stamped, dir, 'init000003.mp4', 3)
    await writeOwn(small, dir, 'init000006.mp4', 6)
    await writeFile(
      join(dir, 'master.m3u8'),
      `${await readFile(join(dir, 'master.m3u8'), 'utf8')}#EXT-X-ENDLIST\n`
    )
  })

  after(async function () {
    if (root != null) await rm(root, { recursive: true, force: true })
  })

  it('has its parts in order, each under its own map', async function () {
    const playlist = parseMediaPlaylist(
      await readFile(join(dir, 'master.m3u8'), 'utf8')
    )
    expect(playlist.map?.uri).equals('init.mp4')
    expect(
      playlist.segments.map(segment => segment.map?.uri ?? playlist.map?.uri)
    ).deep.equals([
      'init.mp4',
      'init.mp4',
      'init.mp4',
      'init000003.mp4',
      'init000003.mp4',
      'init000003.mp4',
      'init000006.mp4',
      'init000006.mp4',
      'init000006.mp4'
    ])
  })

  it("reads each segment's frames by its own init segment while live", async function () {
    const { unreadable, cursor } = await scanNewSegments(
      dir,
      undefined,
      () => START_MS + 60_000,
      20
    )
    expect(unreadable).deep.equals([])
    expect(cursor.segments).equals(9)
  })

  it('checks its sound against the first part alone', async function () {
    const placement = await checkTrackStarts(join(dir, 'master.m3u8'))
    expect(placement?.offsetSec).equals(0)
  })

  it('still has its length, from the playlist', async function () {
    const duration = await probeDuration(
      ffprobeFor(FFMPEG),
      join(dir, 'master.m3u8')
    )
    expect(duration).closeTo(9, 0.2)
  })

  it('cuts a still from any part of the live playlist, at its own size', async function () {
    const frame = await readLocalFrame(join(dir, 'master.m3u8'), 4.5, root)
    expect(frame).not.equals(undefined)
    expect(await videoSize(frame!.path)).equals('320,240')
    await frame!.release()
    const first = await readLocalFrame(join(dir, 'master.m3u8'), 0.5, root)
    expect(await videoSize(first!.path)).equals('160,120')
    await first!.release()
  })

  describe('finished', function () {
    let result: Awaited<ReturnType<typeof toRecording>>

    before(async function () {
      result = await toRecording(FFMPEG, dir, () => undefined)
    })

    it('is the three files every recording is', function () {
      expect(result.files).deep.equals([
        'master.m3u8',
        'video.m3u8',
        'video.mp4'
      ])
      expect(result.durationSec).closeTo(9, 0.2)
      // The largest part's, not the first's.
      expect(result.width).equals(320)
      expect(result.height).equals(240)
    })

    it('says in its master what its largest part needs', async function () {
      const master = await readFile(join(dir, 'master.m3u8'), 'utf8')
      const variant = master
        .split('\n')
        .find(line => line.startsWith('#EXT-X-STREAM-INF:'))
      expect(variant).contains('RESOLUTION=320x240')
      expect(variant).match(/CODECS="hvc1\.[^",]+,mp4a\.40\.2"/)
      expect(master.trimEnd().split('\n').at(-1)).equals('video.m3u8')
    })

    it("decodes whole, part by part, with each part's own init segment", async function () {
      const body = await readFile(join(dir, 'video.m3u8'), 'utf8')
      const playlist = parseMediaPlaylist(body)
      expect(body.match(/#EXT-X-DISCONTINUITY/g)).length(2)
      const groups = new Map<number, Uint8Array[]>()
      for (const segment of playlist.segments) {
        const map = segment.map ?? playlist.map!
        const at = map.range?.offset ?? 0
        const parts = groups.get(at) ?? [
          await readPart(join(dir, map.uri), map.range)
        ]
        parts.push(await readPart(join(dir, segment.uri), segment.range))
        groups.set(at, parts)
      }
      expect(groups.size).equals(3)
      const sizes: string[] = []
      let index = 0
      for (const parts of groups.values()) {
        const path = join(root, `part${String(index++)}.mp4`)
        await writeFile(path, Buffer.concat(parts))
        expect(await decodeErrors(path)).equals('')
        sizes.push(await videoSize(path))
      }
      expect(sizes).deep.equals(['160,120', '320,240', '160,120'])
    })

    it('is read for its stamps from the part that carries them', async function () {
      const scan = await readRecordingStamps(dir)
      expect(scan.stamped).length(1)
      expect(scan.stamped[0][0]).closeTo(3000, 200)
      expect(scan.stamped[0][1]).closeTo(6000, 200)
      expect(scan.points.length).above(0)
    })

    it('cuts a still from any part of the file', async function () {
      const video = join(dir, 'video.mp4')
      const frame = await readLocalFrame(video, 4.5, root)
      expect(await videoSize(frame!.path)).equals('320,240')
      await frame!.release()
      const last = await readLocalFrame(video, 7.5, root)
      expect(await videoSize(last!.path)).equals('160,120')
      await last!.release()
    })
  })
})

describe('two configurations apart on the clock', function () {
  this.timeout(120_000)
  // Past what `covers` allows an upload to fall short by.
  const GAP_SEC = 150
  let root: string
  let dir: string
  let live: string
  let spanLive: number | undefined
  let recording: VodResult

  /** A later camera's writer: on the clock, as the splitter places its segments. */
  async function writePlaced(
    input: string,
    initName: string,
    startNumber: number,
    atSec: number
  ): Promise<void> {
    const before = new Set(
      listedSegments(await readFile(join(dir, 'master.m3u8'), 'utf8')).map(
        segment => segment.name
      )
    )
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      input,
      '-c',
      'copy',
      '-tag:v',
      'hvc1',
      '-f',
      'hls',
      '-hls_time',
      '1',
      '-hls_playlist_type',
      'event',
      '-hls_segment_type',
      'fmp4',
      '-hls_fmp4_init_filename',
      initName,
      ...KEEP_STREAM_TIMES,
      '-hls_flags',
      'independent_segments+temp_file+omit_endlist',
      '-start_number',
      String(startNumber),
      '-hls_segment_filename',
      join(dir, 'seg%06d.m4s'),
      join(dir, WRITER_PLAYLIST_NAME)
    ])
    const init = await readFile(join(dir, initName))
    for (const { name } of listedSegments(
      await readFile(join(dir, WRITER_PLAYLIST_NAME), 'utf8')
    )) {
      if (before.has(name)) continue
      const path = join(dir, name)
      writeStamped(
        path,
        placeSegmentOnTimeline(init, await readFile(path), atSec)!
      )
    }
    absorbWriterPlaylist(dir)
  }

  before(async function () {
    if (!(await canEncode('libx265', 'aac'))) this.skip()
    root = await mkdtemp(join(tmpdir(), 'tsMismatchedGap-'))
    dir = join(root, 'video')
    await mkdir(dir)
    const small = join(root, 'small.mp4')
    const large = join(root, 'large.mp4')
    await encodeFragmented(small, { codec: 'hevc', seconds: 3, sound: true })
    await encodeFragmented(large, {
      codec: 'hevc',
      seconds: 3,
      size: '320x240',
      sound: true
    })
    await writeLive(small, dir, {})
    const end = listedSegments(
      await readFile(join(dir, 'master.m3u8'), 'utf8')
    ).reduce((sum, segment) => sum + segment.durationSec, 0)
    const firstLater = listedSegments(
      await readFile(join(dir, 'master.m3u8'), 'utf8')
    ).length
    await writePlaced(
      large,
      `init${String(firstLater).padStart(6, '0')}.mp4`,
      firstLater,
      end + GAP_SEC
    )
    await writeFile(
      join(dir, 'master.m3u8'),
      `${await readFile(join(dir, 'master.m3u8'), 'utf8')}#EXT-X-ENDLIST\n`
    )
    live = await readFile(join(dir, 'master.m3u8'), 'utf8')
    spanLive = await recordingSpanSec(dir, live)
    recording = await toRecording(FFMPEG, dir, () => undefined)
  })

  after(async function () {
    if (root != null) await rm(root, { recursive: true, force: true })
  })

  it('reads its span from the clock while it is still the live playlist', async function () {
    expect(spanLive).closeTo(GAP_SEC + 6, 0.5)
    expect(
      await probeDuration(ffprobeFor(FFMPEG), join(dir, 'video.m3u8'))
    ).closeTo(GAP_SEC + 6, 0.5)
  })

  it('keeps the gap in the file, and says it in the length', async function () {
    expect(recording.durationSec).closeTo(GAP_SEC + 6, 0.5)
    const media = await readFile(join(dir, 'video.m3u8'), 'utf8')
    const lines = media.split('\n')
    const secondMap = lines.findIndex(
      (line, index) =>
        line.startsWith('#EXT-X-MAP:') &&
        lines.slice(0, index).some(one => one.startsWith('#EXT-X-MAP:'))
    )
    const before = lines
      .slice(0, secondMap)
      .filter(line => line.startsWith('#EXTINF:'))
      .reduce(
        (sum, line) => sum + Number.parseFloat(line.slice('#EXTINF:'.length)),
        0
      )
    // The later part opens where the clock has it.
    expect(before).closeTo(GAP_SEC + 3, 0.5)
  })

  it('says where that moved the live positions', function () {
    expect(recording.moved).length(1)
    expect(recording.moved[0].fromMs).closeTo(3000, 200)
    expect(recording.moved[0].byMs).closeTo(GAP_SEC * 1000, 500)
  })

  it('fills the gap with pictures that decode, and goes on with each part', async function () {
    const body = await readFile(join(dir, 'video.m3u8'), 'utf8')
    const playlist = parseMediaPlaylist(body)
    const groups = new Map<number, Uint8Array[]>()
    for (const segment of playlist.segments) {
      const map = segment.map ?? playlist.map!
      const at = map.range?.offset ?? 0
      const parts = groups.get(at) ?? [
        await readPart(join(dir, map.uri), map.range)
      ]
      parts.push(await readPart(join(dir, segment.uri), segment.range))
      groups.set(at, parts)
    }
    expect(groups.size).equals(2)
    const sizes: string[] = []
    let index = 0
    for (const parts of groups.values()) {
      const path = join(root, `part${String(index++)}.mp4`)
      await writeFile(path, Buffer.concat(parts))
      expect(await decodeErrorsAcrossGap(path)).deep.equals([])
      sizes.push(await videoSize(path))
    }
    expect(sizes).deep.equals(['160,120', '320,240'])
  })

  it('no longer lets an upload of the first part alone cover it', function () {
    const startAt = '2026-05-20T16:00:00.000Z'
    const live = { startAt, durationSec: recording.durationSec }
    expect(covers({ startAt, durationSec: 3 }, live)).equals(false)
    expect(
      covers({ startAt, durationSec: recording.durationSec + 1 }, live)
    ).equals(true)
  })

  it('has no span to read from a playlist of one configuration or none it can read', async function () {
    expect(await recordingSpanSec(dir, '#EXTM3U\n')).equals(undefined)
    const missing = live.replace(/seg\d+\.m4s/g, 'seg999999.m4s')
    expect(await recordingSpanSec(dir, missing)).equals(undefined)
  })
})

describe('reading frames under a later map', function () {
  /** Swaps tracks 1 and 2 in every box of `type`, where the id is at `at`. */
  const swapTracks = (bytes: Buffer, type: string, at: number): Buffer => {
    const out = Buffer.from(bytes)
    let found = out.indexOf(type, 0, 'latin1')
    while (found >= 0) {
      const id = found + 4 + at
      out.writeUInt32BE(3 - out.readUInt32BE(id), id)
      found = out.indexOf(type, found + 4, 'latin1')
    }
    return out
  }
  let dir: string

  before(async function () {
    dir = await mkdtemp(join(tmpdir(), 'tsLaterMap-'))
    const stamped = (atSec: number): Buffer =>
      hevcSegment(atSec, [wallClockNal(START_MS + atSec * 1000), IDR_SLICE])
    await writeFile(join(dir, 'init.mp4'), hevcInit())
    await writeFile(
      join(dir, 'init000001.mp4'),
      swapTracks(hevcInit(), 'tkhd', 12)
    )
    await writeFile(join(dir, 'seg000000.m4s'), stamped(0))
    await writeFile(
      join(dir, 'seg000001.m4s'),
      swapTracks(stamped(4), 'tfhd', 4)
    )
    await writeFile(
      join(dir, 'master.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:4.000000,',
        'seg000000.m4s',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-MAP:URI="init000001.mp4"',
        '#EXTINF:4.000000,',
        'seg000001.m4s',
        '#EXT-X-ENDLIST',
        ''
      ].join('\n')
    )
  })

  after(async function () {
    await rm(dir, { recursive: true, force: true })
  })

  it('finds the picture of a part that numbers its tracks another way', async function () {
    const scan = await readRecordingStamps(dir, {
      playlistFile: 'master.m3u8'
    })
    expect(scan.points.map(point => point.wallMs)).deep.equals([
      START_MS,
      START_MS + 4000
    ])
  })

  it('passes over a part whose init segment has no picture to read', async function () {
    await writeFile(join(dir, 'init000002.mp4'), box('ftyp', Buffer.alloc(8)))
    await writeFile(
      join(dir, 'damaged.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXTINF:4.000000,',
        'seg000000.m4s',
        '#EXT-X-DISCONTINUITY',
        '#EXT-X-MAP:URI="init000002.mp4"',
        '#EXTINF:4.000000,',
        'seg000001.m4s',
        '#EXT-X-ENDLIST',
        ''
      ].join('\n')
    )
    const scan = await readRecordingStamps(dir, {
      playlistFile: 'damaged.m3u8'
    })
    expect(scan.points.map(point => point.wallMs)).deep.equals([START_MS])
    expect(scan.durationMs).equals(8000)
  })

  it('does so while live, one look at a time as well', async function () {
    const whole = await scanNewSegments(dir, undefined, () => START_MS, 8)
    expect(whole.points.map(point => point.source)).deep.equals(['sei', 'sei'])
    const first = await scanNewSegments(dir, undefined, () => START_MS, 1)
    const second = await scanNewSegments(dir, first.cursor, () => START_MS, 1)
    expect(second.points.map(point => point.wallMs)).deep.equals([
      START_MS + 4000
    ])
  })
})

describe('splitting a playlist at its configurations', function () {
  const moovs = new Map([
    ['init.mp4', 'a'],
    ['init000003.mp4', 'b'],
    ['init000005.mp4', 'b']
  ])
  const playlist = [
    '#EXTM3U',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.000000,',
    'seg000000.m4s',
    '#EXT-X-DISCONTINUITY',
    '#EXT-X-MAP:URI="init000003.mp4"',
    '#EXTINF:4.000000,',
    'seg000003.m4s',
    '#EXT-X-DISCONTINUITY',
    '#EXT-X-MAP:URI="init000005.mp4"',
    '#EXTINF:4.000000,',
    'seg000005.m4s',
    '#EXT-X-ENDLIST',
    ''
  ].join('\n')

  it('keeps neighbours with the same moov as one run, its discontinuity kept', function () {
    const runs = configurationRuns(playlist, moovs)
    expect(runs.map(run => run.init)).deep.equals([
      'init.mp4',
      'init000003.mp4'
    ])
    expect(runs[1].lines).includes('seg000005.m4s')
    expect(runs[1].lines).includes('#EXT-X-DISCONTINUITY')
    expect(runs[0].lines).not.includes('#EXT-X-DISCONTINUITY')
  })

  it('never merges what it has no record of', function () {
    expect(configurationRuns(playlist, new Map())).length(3)
  })

  it('has nothing to split in a playlist of one', function () {
    expect(
      configurationRuns('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n', moovs)
    ).length(1)
    expect(configurationRuns('', moovs)).length(0)
  })
})

describe('joining single-file playlists', function () {
  const one = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@0"',
    '#EXTINF:4.000000,',
    '#EXT-X-BYTERANGE:50@100',
    'video.mp4',
    '#EXT-X-ENDLIST',
    ''
  ].join('\n')

  it('moves every byte range along the file', function () {
    const moved = shiftByteRanges(one, 1000)
    expect(moved).contains('BYTERANGE="100@1000"')
    expect(moved).contains('#EXT-X-BYTERANGE:50@1100')
  })

  it('puts a discontinuity and a map between them, and one end', function () {
    const joined = joinMediaPlaylists([
      one,
      shiftByteRanges(one.replace('DURATION:4', 'DURATION:6'), 150)
    ])
    const lines = joined.trimEnd().split('\n')
    expect(lines.slice(0, 3)).deep.equals([
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:6'
    ])
    expect(joined.match(/#EXT-X-ENDLIST/g)).length(1)
    expect(lines.at(-1)).equals('#EXT-X-ENDLIST')
    const at = lines.indexOf('#EXT-X-DISCONTINUITY')
    expect(lines[at + 1]).equals(
      '#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@150"'
    )
    const playlist = parseMediaPlaylist(joined)
    expect(playlist.segments[1].map?.range).deep.equals({
      offset: 150,
      length: 100
    })
    expect(playlist.segments[1].discontinuity).equals(true)
  })
})

describe('one master for parts that differ', function () {
  const master = (variant: string): string =>
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-STREAM-INF:${variant}`,
      'video.m3u8',
      ''
    ].join('\n')

  it('says the most any part needs, keeping the first part’s playlist', function () {
    const joined = combinedMaster([
      master(
        'BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="hvc1.1.6.L93.90,mp4a.40.2"'
      ),
      master(
        'BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L120.90,mp4a.40.2"'
      ),
      master('BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="hvc1.1.6.L90.90"')
    ])
    expect(joined.split('\n')).deep.equals([
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="hvc1.1.6.L120.90,mp4a.40.2"',
      'video.m3u8',
      ''
    ])
  })

  it('takes the high tier over any level of the main, and every sound any part has', function () {
    const joined = combinedMaster([
      master('BANDWIDTH=1,RESOLUTION=640x360,CODECS="hvc1.1.6.L153.90"'),
      master(
        'BANDWIDTH=1,RESOLUTION=640x360,CODECS="hvc1.1.6.H93.90,mp4a.40.2"'
      )
    ])
    expect(joined).contains('CODECS="hvc1.1.6.H93.90,mp4a.40.2"')
  })

  it('compares H.264 levels, and leaves what it cannot read', function () {
    expect(
      combinedMaster([
        master('BANDWIDTH=1,CODECS="avc1.64001f"'),
        master('BANDWIDTH=1,CODECS="avc1.640028"')
      ])
    ).contains('CODECS="avc1.640028"')
    expect(
      combinedMaster([master('BANDWIDTH=7'), master('BANDWIDTH=x')])
    ).contains('#EXT-X-STREAM-INF:BANDWIDTH=7\n')
  })
})
