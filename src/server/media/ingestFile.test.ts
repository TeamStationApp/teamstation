import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ffprobeBeside, preRollFrom, readProbe, tagFor } from './ingestFile'

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
    expect(ffprobeBeside('/srv/teamstation/ffmpeg-9.0.1/bin/ffmpeg')).equals(
      '/srv/teamstation/ffmpeg-9.0.1/bin/ffprobe'
    )
  })

  it('leaves a path that does not end in the name alone', function () {
    expect(ffprobeBeside('/usr/bin/ffmpeg-static')).equals(
      '/usr/bin/ffmpeg-static'
    )
  })
})
