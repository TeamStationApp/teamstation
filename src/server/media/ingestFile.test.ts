import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { AAC_PRIMING_SAMPLES, ffmpegEncoders, remuxToHls } from './ffmpeg'
import {
  ffprobeBeside,
  preRollFrom,
  probeVideoFile,
  readProbe,
  tagFor,
  undeclaredPriming
} from './ingestFile'
import { boxesInFile, readFragment, readTracks } from './trackStarts'

const run = promisify(execFile)
const FFMPEG = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'

describe('the tag a remuxed track keeps', function () {
  it('gives HEVC the tag Safari insists on', function () {
    expect(tagFor('hevc')).equals('hvc1')
    expect(tagFor('h265')).equals('hvc1')
  })

  it('leaves H.264 as what it is', function () {
    // The fault this exists for: tagged `hvc1`, an H.264 track plays nowhere.
    expect(tagFor('h264')).equals('avc1')
    expect(tagFor('avc1')).equals('avc1')
  })

  it('does not guess at anything else', function () {
    expect(tagFor('vp9')).equals(null)
    expect(tagFor('')).equals(null)
  })
})

describe('the pre-roll an edit list leaves in the remux', function () {
  // Measured off a Director programme export, 2026-09-17-00-45-40.mov: its
  // video track is trimmed by 0.500 s and its sound by 0.022 s, and the copy
  // FFmpeg makes of it runs 0.503 s longer than the file presents itself as.
  // The same take's `home` camera archive reads 0.033 s, so the two of them
  // were 0.467 s out from each other in the grid.
  const measured = [
    { stream_index: 0, dts_time: '-0.500000' },
    { stream_index: 1, dts_time: '-0.022000' },
    { stream_index: 0, dts_time: '-0.483333' },
    { stream_index: 1, dts_time: '-0.000667' }
  ]

  it('is how far back the deepest stream starts', function () {
    // Not the video's 0.500 s because it is the video's: because it is the
    // deeper of the two, and FFmpeg shifts everything by that one.
    expect(preRollFrom(measured)).closeTo(0.5, 0.0001)
  })

  it('is nothing at all for a file with no edit list', function () {
    expect(
      preRollFrom([
        { stream_index: 0, dts_time: '0.000000' },
        { stream_index: 1, dts_time: '0.000000' }
      ])
    ).equals(0)
  })

  it('is nothing when ffprobe gave no packets to read', function () {
    expect(preRollFrom([])).equals(0)
  })

  it('goes negative for a file whose own timeline starts late', function () {
    // `make_zero` puts the first timestamp at zero whichever side of it that
    // timestamp is, so a source that starts late is pulled forward and its
    // copy begins earlier than the file did. Clamping this at zero left half
    // a second of nothing at the head of the copy with the row saying the
    // first picture was at media time zero — finding 28 from the other side.
    expect(
      preRollFrom([
        { stream_index: 0, dts_time: '1.000000' },
        { stream_index: 1, dts_time: '0.477000' }
      ])
    ).closeTo(-0.477, 0.0001)
  })

  it('ignores a packet with no timestamp rather than reading it as zero', function () {
    // Counting an unreadable packet as zero would hide a pre-roll the stream
    // really has.
    expect(
      preRollFrom([
        { stream_index: 0 },
        { stream_index: 0, dts_time: 'N/A' },
        { stream_index: 0, dts_time: '-0.250000' }
      ])
    ).closeTo(0.25, 0.0001)
  })

  it('is a frame for a camera archive, whose B-frames decode early', function () {
    // Every camera archive measured presents from zero and decodes from
    // −0.033 s, and its copy really does present that frame late: the muxer
    // puts the first *decode* time at zero and carries the pictures with it.
    // Reading presentation time here leaves all four angles 33 ms behind.
    expect(
      preRollFrom([
        { stream_index: 0, dts_time: '-0.033333' },
        { stream_index: 0, dts_time: '-0.016667' },
        { stream_index: 1, dts_time: '0.000000' }
      ])
    ).closeTo(0.033333, 0.0001)
  })
})

describe('reading what ffprobe says about a recording', function () {
  const probe = (
    streams: unknown[],
    duration = '7344.5',
    packets: unknown[] = []
  ): string => JSON.stringify({ streams, packets, format: { duration } })

  it('takes the video stream, not the first one', function () {
    // A Director export leads with its sound on some takes.
    const read = readProbe(
      probe([
        { codec_type: 'audio', codec_name: 'aac' },
        { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080 }
      ]),
      'take.mov'
    )
    expect(read.codecName).equals('hevc')
    expect(read.width).equals(1920)
    expect(read.hasAudio).equals(true)
  })

  it('rounds the length to the second it will be stored as', function () {
    const read = readProbe(
      probe([
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }
      ]),
      'take.mov'
    )
    expect(read.durationSec).equals(7345)
  })

  it('counts the pre-roll into the length it will be stored as', function () {
    // The stored length has to describe what is in the Space, which is the
    // presented length plus the pre-roll the remux could not drop.
    const read = readProbe(
      probe(
        [
          { codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080 }
        ],
        '601.13',
        [
          { stream_index: 0, dts_time: '-0.500000' },
          { stream_index: 1, dts_time: '-0.022000' }
        ]
      ),
      'take.mov'
    )
    expect(read.preRollSec).closeTo(0.5, 0.0001)
    expect(read.durationSec).equals(602)
  })

  it('says a file with no edit list has no pre-roll', function () {
    const read = readProbe(
      probe([
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }
      ]),
      'take.mov'
    )
    expect(read.preRollSec).equals(0)
  })

  it('says when there is no sound at all', function () {
    const read = readProbe(
      probe([
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }
      ]),
      'silent.mov'
    )
    expect(read.hasAudio).equals(false)
  })

  it('refuses a file with no video stream rather than importing silence', function () {
    expect(() =>
      readProbe(
        probe([{ codec_type: 'audio', codec_name: 'aac' }]),
        'sound.m4a'
      )
    ).throws('no video stream in sound.m4a')
  })
})

describe('finding ffprobe', function () {
  it('is the one beside the ffmpeg this server is pinned to', function () {
    expect(ffprobeBeside('/var/app/ffmpeg-9.0.2/bin/ffmpeg')).equals(
      '/var/app/ffmpeg-9.0.2/bin/ffprobe'
    )
  })

  it('leaves a path that does not end in the name alone', function () {
    expect(ffprobeBeside('/usr/bin/ffmpeg-static')).equals(
      '/usr/bin/ffmpeg-static'
    )
  })
})

describe('AAC priming a file does not declare', function () {
  const aac = {
    index: 1,
    codec_type: 'audio',
    codec_name: 'aac',
    profile: 'LC',
    sample_rate: '48000',
    initial_padding: 0
  }

  it('is the 2,112 samples Apple’s encoders write, on AAC-LC that says nothing', function () {
    expect(undeclaredPriming(aac)).equals(AAC_PRIMING_SAMPLES)
    expect(AAC_PRIMING_SAMPLES).equals(2112)
  })

  it('is nothing where the file declares its own, or for anything else', function () {
    expect(undeclaredPriming({ ...aac, initial_padding: 2112 })).equals(0)
    expect(undeclaredPriming({ ...aac, initial_padding: 1024 })).equals(0)
    expect(undeclaredPriming({ ...aac, profile: 'HE-AAC' })).equals(0)
    expect(undeclaredPriming({ ...aac, codec_name: 'opus' })).equals(0)
    expect(undeclaredPriming({ ...aac, sample_rate: undefined })).equals(0)
    expect(undeclaredPriming({ ...aac, initial_padding: undefined })).equals(
      AAC_PRIMING_SAMPLES
    )
    expect(undeclaredPriming(undefined)).equals(0)
  })

  const probe = (streams: unknown[], packets: unknown[]): string =>
    JSON.stringify({ streams, packets, format: { duration: '4721.0' } })
  const hevc = {
    index: 0,
    codec_type: 'video',
    codec_name: 'hevc',
    width: 1920,
    height: 1080
  }

  it('moves the sound back, and the pre-roll with it where it is the deepest', function () {
    // A camera angle: its B-frames start the picture one frame (33 ms) back,
    // and the sound's undeclared priming is 44 ms, which is now the deepest.
    const read = readProbe(
      probe(
        [hevc, aac],
        [
          { stream_index: 0, dts_time: '-0.033333' },
          { stream_index: 1, dts_time: '0.000000' }
        ]
      ),
      'angle.mov'
    )
    expect(read.soundPrimingSamples).equals(2112)
    expect(read.preRollSec).closeTo(0.044, 0.000001)
  })

  it('leaves the pre-roll to the picture where the picture is deeper', function () {
    // The programme: three B-frames, 67 ms back.
    const read = readProbe(
      probe(
        [hevc, aac],
        [
          { stream_index: 0, dts_time: '-0.066667' },
          { stream_index: 1, dts_time: '0.000000' }
        ]
      ),
      'programme.mov'
    )
    expect(read.preRollSec).closeTo(0.066667, 0.000001)
  })

  it('changes nothing for a file that declares its priming', function () {
    const read = readProbe(
      probe(
        [hevc, { ...aac, initial_padding: 2112 }],
        [
          { stream_index: 0, dts_time: '0.000000' },
          { stream_index: 1, dts_time: '-0.044000' }
        ]
      ),
      'declared.mov'
    )
    expect(read.soundPrimingSamples).equals(0)
    expect(read.preRollSec).closeTo(0.044, 0.000001)
  })

  it('moves only the stream it is told to', function () {
    expect(
      preRollFrom(
        [
          { stream_index: 0, dts_time: '0' },
          { stream_index: 1, dts_time: '0' }
        ],
        new Map([[1, 0.044]])
      )
    ).closeTo(0.044, 0.000001)
  })
})

describe('a remux of sound whose priming is undeclared, through real ffmpeg', function () {
  this.timeout(60_000)
  let dir = ''
  let file = ''

  before(async function () {
    let encoders: Set<string>
    try {
      encoders = await ffmpegEncoders(FFMPEG)
    } catch {
      this.skip()
      return
    }
    if (!encoders.has('libx264') || !encoders.has('aac')) this.skip()
    dir = await mkdtemp(join(tmpdir(), 'tsPriming-'))
    // AAC carried as ADTS declares no priming, so muxed into a .mov it
    // arrives the way TS Director's and TS Distributor's files do.
    const adts = join(dir, 'sound.aac')
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000:duration=3',
      '-c:a',
      'aac',
      '-f',
      'adts',
      adts
    ])
    file = join(dir, 'take.mov')
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x120:rate=30:duration=3',
      '-i',
      adts,
      '-c:v',
      'libx264',
      '-bf',
      '0',
      '-c:a',
      'copy',
      file
    ])
  })

  after(async function () {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  /** How far the sound's first fragment starts after the picture's. */
  async function soundAfterPicture(outDir: string): Promise<number> {
    const path = join(outDir, 'video.mp4')
    let tracks = readTracks(Buffer.alloc(0))
    for await (const moov of boxesInFile(path, 'moov'))
      tracks = readTracks(moov)
    for await (const moof of boxesInFile(path, 'moof')) {
      const runs = readFragment(moof, tracks)
      const picture = runs.find(one => one.kind === 'video')
      const sound = runs.find(one => one.kind === 'audio')
      if (picture != null && sound != null) {
        return sound.startSec - picture.startSec
      }
    }
    throw new Error('no fragment carried both')
  }

  it('starts the real sound with the picture', async function () {
    const probed = await probeVideoFile(FFMPEG, file)
    expect(probed.soundPrimingSamples).equals(2112)

    const asIs = join(dir, 'asIs')
    await mkdir(asIs)
    await remuxToHls(FFMPEG, { input: file, outDir: asIs, videoTag: null })
    const honoured = join(dir, 'honoured')
    await mkdir(honoured)
    await remuxToHls(FFMPEG, {
      input: file,
      outDir: honoured,
      videoTag: null,
      soundPrimingSamples: probed.soundPrimingSamples
    })

    expect(await soundAfterPicture(asIs)).closeTo(0, 0.0001)
    // The priming now plays before the first picture, so the first real
    // sample is with it.
    expect(await soundAfterPicture(honoured)).closeTo(-2112 / 48000, 0.0001)
    expect(await readFile(join(honoured, 'video.m3u8'), 'utf8')).contains(
      '#EXT-X-ENDLIST'
    )
  })
})
