import { expect } from 'chai'
import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { tmpdir } from 'os'
import { join } from 'path'

import { ffprobeFor, VIDEO_FILE } from '../media/ffmpeg'
import { RECONNECT_GRACE_MS } from './controller'
import { fileForRemux, toRecording } from './finishVideo'
import {
  annexBUnits,
  encodeBlackPicture,
  frameRate,
  hvcCUnits,
  initWithHvcC,
  MAX_HOLE_SEC,
  planHole,
  readSampleEntry,
  renumberPicture,
  type SegmentSpan
} from './holeFiller'
import { segmentsFrom, stampNewSegments } from './segmentClock'

function findFfmpeg(): string {
  const ffmpeg = process.env.TS_FFMPEG ?? '/opt/homebrew/bin/ffmpeg'
  try {
    execFileSync(ffmpeg, ['-version'])
    return ffmpeg
  } catch {
    return ''
  }
}

/** A closed live playlist of two one-second publishes, `gapSec` apart. */
function liveWithHole(
  ffmpeg: string,
  dir: string,
  codec: string[],
  gapSec = 30
): void {
  const common = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x120:rate=30:duration=1',
    ...codec,
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_playlist_type',
    'event',
    '-hls_segment_type',
    'fmp4',
    '-hls_segment_filename',
    join(dir, 'seg%06d.m4s')
  ]
  const playlist = join(dir, 'master.m3u8')
  execFileSync(ffmpeg, [
    ...common,
    '-hls_flags',
    'independent_segments+omit_endlist',
    playlist
  ])
  execFileSync(ffmpeg, [
    ...common,
    '-hls_flags',
    'independent_segments+append_list+omit_endlist',
    playlist
  ])
  stampNewSegments(dir, 1 + gapSec, segmentsFrom(dir, 1))
  writeFileSync(
    playlist,
    `${readFileSync(playlist, 'utf8').trimEnd()}\n#EXT-X-ENDLIST\n`
  )
}

const span = (overrides: Partial<SegmentSpan> = {}): SegmentSpan => ({
  videoEnd: 1,
  videoLead: 0,
  soundEnd: 1,
  soundLead: 0,
  frameSec: 1 / 30,
  ...overrides
})

describe('filling a live recording’s holes', function () {
  it('refuses only a hole far longer than the reconnect grace', function () {
    expect(MAX_HOLE_SEC * 1000).greaterThan(4 * RECONNECT_GRACE_MS)
  })

  it('reads the frame rate from a picture’s length, in any timescale', function () {
    // A 30 fps stream in milliseconds averages 33.3 ms.
    expect(frameRate(0.0333)).deep.equals({ num: 30, den: 1 })
    expect(frameRate(1001 / 30000)).deep.equals({ num: 30000, den: 1001 })
    expect(frameRate(1 / 60)).deep.equals({ num: 60, den: 1 })
    expect(frameRate(1 / 25)).deep.equals({ num: 25, den: 1 })
    expect(frameRate(0.07)).deep.equals({ num: 14, den: 1 })
  })

  it('ends the filler where the return starts, on its frame grid', function () {
    const plan = planHole(
      0,
      span({ videoEnd: 1.01 }),
      31,
      span({ videoLead: 0.02, soundLead: 0.01 }),
      { num: 30, den: 1 },
      48000
    )
    if (plan == null || typeof plan === 'string') throw new Error('no plan')
    expect(plan.frames).equals(900)
    expect(plan.beforeSec).closeTo(1.02, 1e-9)
    expect(plan.fillerSec).closeTo(29.98, 1e-9)
    // Silence from the end of the sound before, stopping short of the next.
    expect(plan.soundOffsetSec).equals(0)
    expect(plan.soundFrames).equals(Math.floor((29.99 * 48000) / 1024))
  })

  it('fills a hole just past the grace all the way to the return', function () {
    // The grace runs from when the server notices the publisher has gone,
    // which is after its last picture, so a late return leaves a longer hole.
    const nextStart = 1 + RECONNECT_GRACE_MS / 1000 + 7.5
    const lead = 0.02
    const plan = planHole(
      0,
      span(),
      nextStart,
      span({ videoLead: lead }),
      { num: 30, den: 1 },
      48000
    )
    if (plan == null || typeof plan === 'string') throw new Error('no plan')
    const returnAt = nextStart + lead
    const fillerStart = plan.beforeSec
    expect(plan.frames / 30).closeTo(returnAt - fillerStart, 1e-9)
    expect(fillerStart + plan.frames / 30).closeTo(returnAt, 1e-9)
    expect(fillerStart + plan.fillerSec).closeTo(nextStart, 1e-9)
    // Less than half a frame is left to the picture before the hole.
    expect(plan.beforeSec).closeTo(1, 0.5 / 30)
  })

  it('starts the silence where the sound before the hole ends', function () {
    const plan = planHole(
      0,
      span({ soundEnd: 1.03 }),
      31,
      span(),
      { num: 30, den: 1 },
      48000
    )
    if (plan == null || typeof plan === 'string') throw new Error('no plan')
    expect(plan.soundOffsetSec).closeTo(0.03, 1e-9)
  })

  it('leaves a gap under a frame alone, and refuses an absurd hole', function () {
    expect(planHole(0, span(), 1.01, span(), { num: 30, den: 1 })).equals(
      undefined
    )
    const absurd = planHole(0, span(), 2 + MAX_HOLE_SEC, span(), {
      num: 30,
      den: 1
    })
    expect(absurd).equals(`a 3601.0 s hole is longer than ${MAX_HOLE_SEC} s`)
  })

  it('splits Annex B on three- and four-byte start codes', function () {
    const units = annexBUnits(
      Buffer.from([0, 0, 0, 1, 0x40, 1, 9, 0, 0, 1, 0x42, 1, 8])
    )
    expect(units.map(unit => [...unit])).deep.equals([
      [0x40, 1, 9],
      [0x42, 1, 8]
    ])
  })

  it('refuses parameter sets it cannot renumber', function () {
    expect(() => renumberPicture([], [])).throws(/one IDR slice/)
    expect(readSampleEntry(Buffer.from('not an mp4'))).equals(
      'no hvcC in the init segment'
    )
    expect(() => initWithHvcC(Buffer.alloc(16), Buffer.alloc(0))).throws(
      /no hvcC/
    )
  })

  describe('with FFmpeg', function () {
    let ffmpeg = ''
    let dir = ''
    beforeEach(function () {
      ffmpeg = findFfmpeg()
      if (ffmpeg === '') this.skip()
      dir = mkdtempSync(join(tmpdir(), 'ts-hole-filler-'))
    })
    afterEach(function () {
      if (dir !== '') rmSync(dir, { recursive: true, force: true })
    })

    it('renumbers a black picture beside the phone’s sets, and it decodes black', async function () {
      this.timeout(20_000)
      const shape = {
        width: 64,
        height: 64,
        pixFmt: 'yuv420p',
        colorRange: 'tv',
        videoIndex: 0,
        videoTimescale: 15360
      }
      const units = await encodeBlackPicture(ffmpeg, shape)
      const own = units.filter(unit => unit[0] >> 1 >= 32)
      const picture = renumberPicture(units, own)
      // Ids 1 sit beside the phone's 0, and every set is new.
      expect(picture.parameterSets.length).equals(3)
      for (const nal of picture.parameterSets) {
        expect(own.some(other => other.equals(nal))).equals(false)
      }
      const start = Buffer.from([0, 0, 0, 1])
      const stream = join(dir, 'both.hevc')
      writeFileSync(
        stream,
        Buffer.concat(
          [...own, ...picture.parameterSets, picture.slice].flatMap(nal => [
            start,
            nal
          ])
        )
      )
      const luma = execFileSync(ffmpeg, [
        '-v',
        'error',
        '-xerror',
        '-f',
        'hevc',
        '-i',
        stream,
        '-vf',
        'extractplanes=y',
        '-f',
        'rawvideo',
        'pipe:1'
      ])
      expect(luma.length).equals(64 * 64)
      expect(Math.max(...luma)).equals(16)
    })

    it('keeps the holes unfilled for a stream it cannot match', async function () {
      this.timeout(20_000)
      liveWithHole(ffmpeg, dir, ['-c:v', 'libx264', '-bf', '0', '-g', '30'])
      const said: string[] = []
      const list = await fileForRemux(dir, ffmpeg, message =>
        said.push(message)
      )
      expect(said.join('\n')).match(/holes kept unfilled: no hvcC/)
      const text = readFileSync(list, 'utf8')
      expect(text).match(/duration 31\.0/)
      expect(text).not.match(/filler\d\.mp4/)
    })

    it('keeps the holes unfilled when a hole is absurdly long', async function () {
      this.timeout(20_000)
      liveWithHole(
        ffmpeg,
        dir,
        [
          '-c:v',
          'libx265',
          '-x265-params',
          'log-level=error:bframes=0:keyint=30',
          '-tag:v',
          'hvc1'
        ],
        MAX_HOLE_SEC + 10
      )
      const said: string[] = []
      const list = await fileForRemux(dir, ffmpeg, message =>
        said.push(message)
      )
      expect(said.join('\n')).match(
        /holes kept unfilled: a 3610\.\d s hole is longer than 3600 s/
      )
      expect(readFileSync(list, 'utf8')).not.match(/filler\d\.mp4/)
    })

    it('packs from the unfilled list when the filled remux fails', async function () {
      this.timeout(30_000)
      liveWithHole(ffmpeg, dir, [
        '-c:v',
        'libx265',
        '-x265-params',
        'log-level=error:bframes=0:keyint=30',
        '-tag:v',
        'hvc1'
      ])
      // An FFmpeg that refuses any concat list naming a filler.
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      const wrapper = join(bin, 'ffmpeg')
      writeFileSync(
        wrapper,
        [
          '#!/bin/sh',
          'for arg in "$@"; do',
          '  case "$arg" in',
          '    *.txt) grep -q "filler[0-9]*\\.mp4" "$arg" && exit 1 ;;',
          '  esac',
          'done',
          `exec '${ffmpeg}' "$@"`,
          ''
        ].join('\n')
      )
      chmodSync(wrapper, 0o755)
      symlinkSync(ffprobeFor(ffmpeg), join(bin, 'ffprobe'))
      const said: string[] = []
      const recording = await toRecording(wrapper, dir, message =>
        said.push(message)
      )
      expect(said.join('\n')).match(/remux of the filled holes failed/)
      expect(recording.files).includes(VIDEO_FILE)
      expect(recording.durationSec).closeTo(32, 0.5)
      expect(existsSync(join(dir, '.holes'))).equals(false)
    })

    it('keeps the holes unfilled when the filler cannot be made', async function () {
      this.timeout(20_000)
      liveWithHole(ffmpeg, dir, [
        '-c:v',
        'libx265',
        '-x265-params',
        'log-level=error:bframes=0:keyint=30',
        '-tag:v',
        'hvc1'
      ])
      const entry = readSampleEntry(readFileSync(join(dir, 'init.mp4')))
      if (typeof entry === 'string') throw new Error(entry)
      expect(hvcCUnits(entry.payload).lengthSize).equals(4)
      const said: string[] = []
      const list = await fileForRemux(
        dir,
        join(dir, 'no-ffmpeg-here'),
        message => said.push(message)
      )
      expect(said.join('\n')).match(/holes kept unfilled/)
      expect(readFileSync(list, 'utf8')).not.match(/filler\d\.mp4/)
    })
  })
})
