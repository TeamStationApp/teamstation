import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { ffmpegEncoders, KEEP_STREAM_TIMES, remuxToHlsArgs } from './ffmpeg'
import {
  boxesInFile,
  checkTrackStarts,
  isSoundStepProblem,
  placeSound,
  readFragment,
  readTracks,
  SOUND_STEP_TOLERANCE_SEC,
  soundStepProblem
} from './trackStarts'

const run = promisify(execFile)
const FFMPEG = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'

/** One MP4 box. */
function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length + 8, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}

function u32(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4)
  values.forEach((value, i) => out.writeUInt32BE(value, i * 4))
  return out
}

function u64(value: number): Buffer {
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(BigInt(value))
  return out
}

/** A `trak` with the handler and timescale this reader looks at. */
function trak(
  id: number,
  handler: string,
  timescale: number,
  version: 0 | 1 = 0
): Buffer {
  const tkhd =
    version === 1
      ? box('tkhd', u32(0x01000000), u64(0), u64(0), u32(id))
      : box('tkhd', u32(0), u32(0, 0, id))
  const mdhd =
    version === 1
      ? box('mdhd', u32(0x01000000), u64(0), u64(0), u32(timescale))
      : box('mdhd', u32(0), u32(0, 0, timescale))
  const hdlr = box('hdlr', u32(0, 0), Buffer.from(handler, 'latin1'))
  return box('trak', tkhd, box('mdia', mdhd, hdlr))
}

function trex(id: number, defaultDuration: number): Buffer {
  return box('trex', u32(0, id, 1, defaultDuration, 0, 0))
}

const VIDEO = 1
const AUDIO = 2
/** Picture at 90 kHz, sound at 48 kHz, both with defaults in `trex`. */
const MOOV = Buffer.concat([
  trak(VIDEO, 'vide', 90_000),
  trak(AUDIO, 'soun', 48_000, 1),
  box('mvex', trex(VIDEO, 3000), trex(AUDIO, 1024))
])

/** A `traf`: decode time in the track's units, and a run of samples. */
function traf(
  id: number,
  start: number,
  options: {
    count: number
    /** Per-sample durations in the `trun`; otherwise the defaults apply. */
    durations?: number[]
    /** A default duration in the `tfhd` itself. */
    tfhdDefault?: number
    tfdtVersion?: 0 | 1
    omitTfdt?: boolean
  }
): Buffer {
  let flags = 0x2 // a sample description index, to be skipped
  const optional: Buffer[] = [u32(1)]
  if (options.tfhdDefault != null) {
    flags |= 0x8
    optional.push(u32(options.tfhdDefault))
  }
  const tfhd = box('tfhd', u32(flags, id), ...optional)
  const tfdt =
    options.tfdtVersion === 1
      ? box('tfdt', u32(0x01000000), u64(start))
      : box('tfdt', u32(0, start))
  let trun: Buffer
  if (options.durations != null) {
    // data offset, first sample flags, then duration + size + flags + cto
    const samples = options.durations.flatMap(duration => [duration, 100, 0, 0])
    trun = box(
      'trun',
      u32(0x1 | 0x4 | 0x100 | 0x200 | 0x400 | 0x800, options.count, 0, 0),
      u32(...samples)
    )
  } else {
    trun = box(
      'trun',
      u32(0x1 | 0x200, options.count, 0),
      u32(...new Array<number>(options.count).fill(100))
    )
  }
  return box('traf', tfhd, ...(options.omitTfdt === true ? [] : [tfdt]), trun)
}

/** A `moof`'s payload, as `placeSound` is handed it. */
function moof(...trafs: Buffer[]): Buffer {
  return Buffer.concat([box('mfhd', u32(0, 1)), ...trafs])
}

/** Two seconds of picture at 30 fps from `startSec`. */
function picture(startSec: number): Buffer {
  return traf(VIDEO, Math.round(startSec * 90_000), { count: 60 })
}

/** About two seconds of sound, stamped at `startSec`. */
function sound(startSec: number): Buffer {
  return traf(AUDIO, Math.round(startSec * 48_000), {
    count: 94,
    tfdtVersion: 1
  })
}

describe('reading where tracks start', function () {
  const tracks = readTracks(MOOV)

  it('reads each track’s kind, timescale and default duration', function () {
    expect(tracks.get(VIDEO)).deep.equals({
      kind: 'video',
      timescale: 90_000,
      defaultSampleDuration: 3000
    })
    expect(tracks.get(AUDIO)).deep.equals({
      kind: 'audio',
      timescale: 48_000,
      defaultSampleDuration: 1024
    })
  })

  it('names a track it does not play as other, and skips a broken one', function () {
    const odd = readTracks(
      Buffer.concat([
        trak(3, 'text', 1000),
        box('trak', box('tkhd', u32(0), u32(0, 0, 4))),
        box('mvex', trex(9, 50), box('free'))
      ])
    )
    expect(odd.get(3)?.kind).equals('other')
    expect(odd.get(3)?.defaultSampleDuration).equals(0)
    expect(odd.has(4)).equals(false)
    expect(odd.has(9)).equals(false)
  })

  it('times a fragment from its tfdt and its samples’ durations', function () {
    const runs = readFragment(
      moof(
        picture(10),
        traf(AUDIO, 48_000 * 11, { count: 3, durations: [1024, 1024, 960] }),
        traf(AUDIO, 0, { count: 2, tfhdDefault: 2048 }),
        traf(7, 0, { count: 1 }),
        traf(VIDEO, 0, { count: 1, omitTfdt: true })
      ),
      tracks
    )
    expect(runs).deep.equals([
      { trackId: VIDEO, kind: 'video', startSec: 10, durationSec: 2 },
      {
        trackId: AUDIO,
        kind: 'audio',
        startSec: 11,
        durationSec: 3008 / 48_000
      },
      {
        trackId: AUDIO,
        kind: 'audio',
        startSec: 0,
        durationSec: 4096 / 48_000
      }
    ])
  })

  it('reads a 64-bit decode time', function () {
    const late = 5 * 3600 * 48_000 * 10
    const [run] = readFragment(
      moof(traf(AUDIO, late, { count: 1, tfdtVersion: 1 })),
      tracks
    )
    expect(run?.startSec).equals(late / 48_000)
  })
})

describe('sound against the picture it arrives with', function () {
  const tracks = readTracks(MOOV)

  it('passes sound that starts late and is stamped where it arrives', async function () {
    // The picture runs from 0 s; the sound camera starts delivering at 29 s.
    const placement = await placeSound(tracks, [
      moof(picture(26)),
      moof(picture(28), sound(29.046)),
      moof(picture(30), sound(32))
    ])
    expect(placement).deep.equals({
      soundStartSec: 29.046,
      pictureStartSec: 28,
      pictureEndSec: 30,
      offsetSec: 0
    })
    expect(soundStepProblem(placement)).equals(undefined)
  })

  it('flags late sound stamped from nought, as the Lizard live copy was', async function () {
    const placement = await placeSound(tracks, [
      moof(picture(1108)),
      moof(picture(1110), sound(0))
    ])
    expect(placement?.offsetSec).equals(-1110)
    expect(soundStepProblem(placement)).equals(
      'sound is stamped 1110.0 s ahead of the picture it arrives with ' +
        '(sound 0.000 s, picture 1110.000–1112.000 s)'
    )
  })

  it('flags sound stamped long after the picture it arrives with', async function () {
    const placement = await placeSound(tracks, [moof(picture(0), sound(600))])
    expect(placement?.offsetSec).equals(598)
    expect(soundStepProblem(placement)).contains('598.0 s behind')
  })

  it('lets sound begin before the first picture', async function () {
    // A camera's sound often starts a moment before its first picture.
    const together = await placeSound(tracks, [moof(picture(0.5), sound(0))])
    expect(together?.offsetSec).equals(0)
    const soundFirst = await placeSound(tracks, [
      moof(sound(0)),
      moof(sound(2)),
      moof(picture(5))
    ])
    expect(soundFirst?.offsetSec).equals(0)
    expect(soundFirst?.pictureStartSec).equals(5)
  })

  it('still flags sound ahead of everything when stamped past the first picture', async function () {
    const placement = await placeSound(tracks, [
      moof(sound(100)),
      moof(picture(0))
    ])
    expect(placement?.offsetSec).equals(98)
  })

  it('measures sound in a fragment of its own against the picture before it', async function () {
    const placement = await placeSound(tracks, [
      moof(picture(40)),
      moof(sound(41))
    ])
    expect(placement?.pictureStartSec).equals(40)
    expect(placement?.offsetSec).equals(0)
  })

  it('has nothing to say with no sound, or no picture', async function () {
    expect(await placeSound(tracks, [moof(picture(0))])).equals(undefined)
    expect(await placeSound(tracks, [moof(sound(0))])).equals(undefined)
    expect(await placeSound(tracks, [])).equals(undefined)
    expect(soundStepProblem(undefined)).equals(undefined)
  })

  it('allows a second either side', function () {
    const at = (offsetSec: number): string | undefined =>
      soundStepProblem({
        soundStartSec: 0,
        pictureStartSec: 0,
        pictureEndSec: 0,
        offsetSec
      })
    expect(at(SOUND_STEP_TOLERANCE_SEC)).equals(undefined)
    expect(at(-SOUND_STEP_TOLERANCE_SEC)).equals(undefined)
    expect(at(1.05)).contains('1.1 s behind')
    expect(at(-1.05)).contains('1.1 s ahead of')
    expect(isSoundStepProblem(at(-1.05))).equals(true)
    expect(isSoundStepProblem('Not yet copied off this machine')).equals(false)
    expect(isSoundStepProblem(null)).equals(false)
  })
})

describe('reading boxes from a file', function () {
  let dir = ''

  before(async function () {
    dir = await mkdtemp(join(tmpdir(), 'tsTrackStarts-'))
  })

  after(async function () {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads every box of one type and skips the rest', async function () {
    // A 64-bit size, then a box that runs to the end of the file.
    const large = Buffer.concat([
      u32(1),
      Buffer.from('mdat', 'latin1'),
      u64(16 + 4),
      u32(7)
    ])
    const toEnd = Buffer.concat([u32(0), Buffer.from('moof'), u32(9)])
    const path = join(dir, 'boxes.mp4')
    await writeFile(
      path,
      Buffer.concat([box('moof', u32(1)), large, box('moof', u32(2)), toEnd])
    )
    const found: number[] = []
    for await (const payload of boxesInFile(path, 'moof')) {
      found.push(payload.readUInt32BE(0))
    }
    expect(found).deep.equals([1, 2, 9])
  })

  it('stops at a truncated box, and reads nothing of a missing file', async function () {
    const path = join(dir, 'cut.mp4')
    await writeFile(
      path,
      Buffer.concat([box('moof', u32(1)), u32(64), Buffer.from('moof')])
    )
    const found: Buffer[] = []
    for await (const payload of boxesInFile(path, 'moof')) found.push(payload)
    expect(found.length).equals(1)
    for await (const payload of boxesInFile(join(dir, 'gone.mp4'), 'moof')) {
      found.push(payload)
    }
    expect(found.length).equals(1)
    const short = join(dir, 'short.mp4')
    await writeFile(short, Buffer.concat([u32(1), Buffer.from('mdat')]))
    for await (const payload of boxesInFile(short, 'mdat')) found.push(payload)
    expect(found.length).equals(1)
  })

  it('reads a playlist’s init segment, then its segments in order', async function () {
    const live = join(dir, 'live')
    await mkdir(live)
    await writeFile(join(live, 'init.mp4'), box('moov', MOOV))
    await writeFile(join(live, 'seg0.m4s'), box('moof', moof(picture(0))))
    await writeFile(
      join(live, 'seg1.m4s'),
      Buffer.concat([box('moof', moof(picture(2), sound(0))), box('mdat')])
    )
    await writeFile(
      join(live, 'master.m3u8'),
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg0.m4s\n#EXTINF:2,\nseg1.m4s\n#EXT-X-ENDLIST\n'
    )
    const placement = await checkTrackStarts(join(live, 'master.m3u8'))
    expect(placement?.offsetSec).equals(-2)
  })

  it('reads a single-file recording once, whatever its playlist repeats', async function () {
    const vod = join(dir, 'vod')
    await mkdir(vod)
    await writeFile(
      join(vod, 'video.mp4'),
      Buffer.concat([
        box('moov', MOOV),
        box('moof', moof(picture(0))),
        box('moof', moof(picture(2)))
      ])
    )
    const playlist = [
      '#EXTM3U',
      '#EXT-X-MAP:URI="video.mp4",BYTERANGE="100@0"',
      ...Array.from({ length: 2 }, () => ['#EXTINF:2,', 'video.mp4']).flat(),
      '#EXT-X-ENDLIST'
    ].join('\n')
    await writeFile(join(vod, 'video.m3u8'), playlist)
    // Picture only: nothing to measure, and no reason to read it twice.
    expect(await checkTrackStarts(join(vod, 'video.m3u8'))).equals(undefined)
  })

  it('has nothing to say about a playlist with no init segment, or a broken one', async function () {
    const bare = join(dir, 'bare')
    await mkdir(bare)
    await writeFile(join(bare, 'a.m3u8'), '#EXTM3U\n#EXTINF:2,\nseg0.ts\n')
    expect(await checkTrackStarts(join(bare, 'a.m3u8'))).equals(undefined)
    await writeFile(
      join(bare, 'b.m3u8'),
      '#EXTM3U\n#EXT-X-MAP:URI="missing.mp4"\n#EXTINF:2,\nseg0.m4s\n'
    )
    expect(await checkTrackStarts(join(bare, 'b.m3u8'))).equals(undefined)
  })
})

describe('a stream whose sound starts late, through real ffmpeg', function () {
  this.timeout(120_000)
  let dir = ''
  let stream = ''

  before(async function () {
    let encoders: Set<string>
    try {
      encoders = await ffmpegEncoders(FFMPEG)
    } catch {
      this.skip()
      return
    }
    if (!encoders.has('libx264') || !encoders.has('aac')) this.skip()
    dir = await mkdtemp(join(tmpdir(), 'tsLateSound-'))
    // What reaches the ingest: picture from 0 s, sound from 4 s, on one
    // RTMP-style clock.
    stream = join(dir, 'late.flv')
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=30',
      '-f',
      'lavfi',
      '-itsoffset',
      '4',
      '-i',
      'sine=frequency=1000:sample_rate=48000',
      '-t',
      '10',
      '-c:v',
      'libx264',
      '-g',
      '30',
      '-c:a',
      'aac',
      '-shortest',
      stream
    ])
  })

  after(async function () {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  /** The live leg's HLS, with or without the stream times kept. */
  async function liveLeg(name: string, keep: boolean): Promise<string> {
    const out = join(dir, name)
    await mkdir(out)
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      stream,
      '-c',
      'copy',
      '-f',
      'hls',
      '-hls_time',
      '2',
      '-hls_playlist_type',
      'event',
      '-hls_segment_type',
      'fmp4',
      '-hls_fmp4_init_filename',
      'init.mp4',
      ...(keep ? KEEP_STREAM_TIMES : []),
      '-hls_flags',
      'independent_segments+temp_file',
      '-hls_segment_filename',
      `${out}/seg%06d.m4s`,
      `${out}/master.m3u8`
    ])
    return join(out, 'master.m3u8')
  }

  it('keeps the sound at 4 s through the live leg and the recording', async function () {
    const live = await liveLeg('kept', true)
    const placement = await checkTrackStarts(live)
    expect(placement?.soundStartSec).within(3.9, 4.2)
    expect(soundStepProblem(placement)).equals(undefined)

    const vod = join(dir, 'kept-vod')
    await mkdir(vod)
    await run(
      FFMPEG,
      remuxToHlsArgs({ input: live, outDir: vod, videoTag: null })
    )
    const recorded = await checkTrackStarts(join(vod, 'video.m3u8'))
    expect(recorded?.soundStartSec).within(3.9, 4.2)
    expect(soundStepProblem(recorded)).equals(undefined)
  })

  it('flags the same stream written without them', async function () {
    const live = await liveLeg('reset', false)
    const placement = await checkTrackStarts(live)
    expect(placement?.soundStartSec).equals(0)
    expect(soundStepProblem(placement)).contains('ahead of the picture')
  })
})
