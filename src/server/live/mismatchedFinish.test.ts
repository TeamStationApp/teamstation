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
import { ffprobeFor, probeDuration } from '../media/ffmpeg'
import { readLocalFrame } from '../media/spaceFrames'
import { checkTrackStarts } from '../media/trackStarts'
import {
  parseMediaPlaylist,
  readPart,
  readRecordingStamps
} from '../media/wallClockScan'
import {
  configurationRuns,
  joinMediaPlaylists,
  shiftByteRanges,
  toRecording
} from './finishVideo'
import {
  box,
  hevcInit,
  hevcSegment,
  IDR_SLICE,
  wallClockNal
} from './frameWallFixture'
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
      expect(result.width).equals(160)
      expect(result.height).equals(120)
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
