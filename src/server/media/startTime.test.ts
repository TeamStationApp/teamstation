import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { serverConfig } from '../serverConfig'
import { ffprobeFor, probeFfmpeg } from './ffmpeg'
import {
  hasOffset,
  parseStamp,
  probeUpload,
  readProbe,
  startFrom
} from './startTime'

const run = promisify(execFile)

describe('what a file says about when it started', function () {
  it('prefers the Apple tag, because it carries its own offset', function () {
    const found = startFrom({
      'com.apple.quicktime.creationdate': '2026-09-19T09:43:08-0700',
      creation_time: '2026-09-19T16:43:08.000000Z'
    })
    expect(found?.source).equals('metadataOffset')
    expect(found?.confidence).equals('high')
    expect(found?.needsConfirming).equals(false)
    expect(found?.at.toISOString()).equals('2026-09-19T16:43:08.000Z')
  })

  it('does not trust the Apple tag once the offset has been lost', function () {
    // A copy that dropped the offset is no better informed than `mvhd` is.
    const found = startFrom({
      'com.apple.quicktime.creationdate': '2026-09-19T09:43:08',
      creation_time: '2026-09-19T16:43:08.000000Z'
    })
    expect(found?.source).equals('metadata')
    expect(found?.confidence).equals('low')
  })

  it('reads creation_time, and never calls it more than low', function () {
    const found = startFrom({ creation_time: '2026-09-19T16:43:08.000000Z' })
    expect(found?.source).equals('metadata')
    // The failure guarded against is a well-formed UTC stamp that was local
    // time all along. Nothing about the text can rule that out.
    expect(found?.confidence).equals('low')
    expect(found?.needsConfirming).equals(true)
    expect(found?.raw).equals('2026-09-19T16:43:08.000000Z')
  })

  it('has nothing to say about a file with no tags', function () {
    expect(startFrom({})).equals(undefined)
    expect(startFrom({ encoder: 'Lavf63.1.101' })).equals(undefined)
  })

  it('ignores a tag that is present but empty', function () {
    expect(startFrom({ creation_time: '   ' })).equals(undefined)
  })

  it('reads a tag whatever case the muxer wrote it in', function () {
    const found = startFrom({ Creation_Time: '2026-09-19T16:43:08Z' })
    expect(found?.source).equals('metadata')
  })

  describe('placeholders', function () {
    it('refuses the epochs muxers write when they do not know', function () {
      // A video recorded in 1904 is not a thing to place on a timeline, and
      // these arrive often enough to be worth naming.
      expect(parseStamp('1904-01-01T00:00:00Z')).equals(undefined)
      expect(parseStamp('1970-01-01T00:00:00Z')).equals(undefined)
      expect(startFrom({ creation_time: '1970-01-01T00:00:00Z' })).equals(
        undefined
      )
    })

    it('refuses something that is not a time at all', function () {
      expect(parseStamp('')).equals(undefined)
      expect(parseStamp('not a date')).equals(undefined)
    })

    it('accepts an ordinary recent stamp', function () {
      expect(parseStamp('2026-09-19T16:43:08Z')?.toISOString()).equals(
        '2026-09-19T16:43:08.000Z'
      )
    })
  })

  describe('spotting a stated offset', function () {
    it('knows the forms that state one', function () {
      expect(hasOffset('2026-09-19T16:43:08Z')).equals(true)
      expect(hasOffset('2026-09-19T09:43:08-0700')).equals(true)
      expect(hasOffset('2026-09-19T09:43:08-07:00')).equals(true)
      expect(hasOffset('2026-09-19T09:43:08+05:30')).equals(true)
    })

    it('knows the form that does not', function () {
      expect(hasOffset('2026-09-19T09:43:08')).equals(false)
      expect(hasOffset('2026-09-19 09:43:08')).equals(false)
    })
  })
})

describe('reading an ffprobe answer', function () {
  it('takes the picture and the length along with the time', function () {
    const probed = readProbe(
      JSON.stringify({
        streams: [
          {
            codec_name: 'hevc',
            codec_tag_string: 'hvc1',
            width: 1920,
            height: 1080,
            tags: { creation_time: '2026-09-19T16:43:08.000000Z' }
          }
        ],
        format: {
          duration: '7568.635000',
          tags: { creation_time: '2026-09-19T16:43:08.000000Z' }
        }
      })
    )
    expect(probed.durationSec).equals(7568.635)
    expect(probed.width).equals(1920)
    expect(probed.height).equals(1080)
    expect(probed.codecName).equals('hevc')
    expect(probed.codecTag).equals('hvc1')
    expect(probed.start?.at.toISOString()).equals('2026-09-19T16:43:08.000Z')
  })

  it('says nothing about the start of what our own remux writes', function () {
    // Copied from the real two-hour recording on the server. The remux drops
    // creation_time, which is the whole reason a start time has to be taken
    // from the original upload and stored rather than read back later.
    const probed = readProbe(
      JSON.stringify({
        streams: [
          {
            codec_name: 'hevc',
            codec_tag_string: 'hvc1',
            width: 1920,
            height: 1080,
            tags: { language: 'und', handler_name: 'VideoHandler' }
          }
        ],
        format: {
          duration: '7568.673667',
          tags: {
            major_brand: 'iso5',
            minor_version: '512',
            compatible_brands: 'iso5iso6mp41',
            encoder: 'Lavf63.1.101'
          }
        }
      })
    )
    expect(probed.start).equals(undefined)
    expect(probed.durationSec).equals(7568.673667)
    expect(probed.codecTag).equals('hvc1')
  })

  it('survives a file ffprobe could not make sense of', function () {
    expect(readProbe('').start).equals(undefined)
    expect(readProbe('not json').tags).deep.equals({})
    expect(readProbe(JSON.stringify({})).durationSec).equals(undefined)
  })

  it('keeps every tag it saw, so a surprising file can be diagnosed', function () {
    const probed = readProbe(
      JSON.stringify({
        format: { tags: { encoder: 'Lavf60.16.100', major_brand: 'iso5' } }
      })
    )
    expect(probed.tags.encoder).equals('Lavf60.16.100')
    expect(probed.tags.major_brand).equals('iso5')
  })
})

/**
 * The parsing above is exercised against text. This runs the real `ffprobe`
 * against real files, because the argument string is as much a part of this as
 * the parsing is: a `-show_entries` that quietly returns nothing would leave
 * every test above passing and every upload without a start time.
 */
describe('probing a real file', function () {
  this.timeout(60000)

  const ffmpegPath = serverConfig.ffmpegPath
  const ffprobePath = ffprobeFor(ffmpegPath)
  let workDir = ''
  let ready = false

  before(async function () {
    try {
      await probeFfmpeg(ffmpegPath)
      ready = true
    } catch {
      ready = false
    }
    if (!ready) {
      this.skip()
      return
    }
    workDir = await mkdtemp(join(tmpdir(), 'tsStart-'))
  })

  after(async function () {
    if (workDir !== '') await rm(workDir, { recursive: true, force: true })
  })

  const make = async (name: string, extra: string[]): Promise<string> => {
    const path = join(workDir, name)
    await run(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=10',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        ...extra,
        path
      ],
      { maxBuffer: 1 << 22 }
    )
    return path
  }

  it('reads a stamped file, with the length and the picture', async function () {
    const file = await make('stamped.mp4', [
      '-metadata',
      'creation_time=2026-09-19T16:43:08Z'
    ])
    const probed = await probeUpload(ffprobePath, file)
    expect(probed.start?.at.toISOString()).equals('2026-09-19T16:43:08.000Z')
    expect(probed.start?.source).equals('metadata')
    expect(probed.start?.needsConfirming).equals(true)
    expect(probed.durationSec).closeTo(1, 0.2)
    expect(probed.width).equals(320)
    expect(probed.codecTag).equals('avc1')
  })

  it('says nothing about a file written without one', async function () {
    const file = await make('bare.mp4', [])
    const probed = await probeUpload(ffprobePath, file)
    // FFmpeg writes no creation_time of its own, which is exactly the state
    // every file our own remux produces is in.
    expect(probed.start).equals(undefined)
    expect(probed.durationSec).closeTo(1, 0.2)
  })

  it('loses the stamp through a plain -c copy, and keeps it with -map_metadata', async function () {
    const source = await make('src.mp4', [
      '-metadata',
      'creation_time=2026-09-19T16:43:08Z'
    ])

    const dropped = join(workDir, 'dropped.mp4')
    await run(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-c',
      'copy',
      dropped
    ])
    // The behaviour the whole design rests on: a remux throws it away unless
    // it is told not to, so a start time must be read and stored up front.
    expect((await probeUpload(ffprobePath, dropped)).start).equals(undefined)

    const kept = join(workDir, 'kept.mp4')
    await run(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-c',
      'copy',
      '-map_metadata',
      '0',
      kept
    ])
    expect(
      (await probeUpload(ffprobePath, kept)).start?.at.toISOString()
    ).equals('2026-09-19T16:43:08.000Z')
  })
})
