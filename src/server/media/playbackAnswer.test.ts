import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { asPlayback } from '../../common/api'
import { playbackAnswer, type PlaybackDeps } from './playbackAnswer'
import type { PlaylistCache } from './spacesHls'

const NOW = Date.parse('2026-11-28T12:00:00Z')

describe('the playback answer’s codec (U8b)', function () {
  let mediaRoot = ''
  let deps: PlaybackDeps
  before(async function () {
    mediaRoot = await mkdtemp(join(tmpdir(), 'playbackAnswer-'))
    deps = {
      mediaRoot,
      space: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: ''
      },
      // A recording reads no playlist: only a live video in the Space does.
      playlists: {} as unknown as PlaylistCache,
      publicUrl: 'https://api.example',
      mediaSecret: 'secret'
    }
  })
  after(async function () {
    await rm(mediaRoot, { recursive: true, force: true })
  })

  it('answers the row’s codec with the address', async function () {
    const answer = await playbackAnswer(
      deps,
      {
        id: 'vid_h264',
        storage: 'spaces',
        kind: 'program',
        durationSec: 60,
        spaceSecret: null,
        codecs: 'avc1'
      },
      NOW
    )
    expect(answer.unavailable).equals(false)
    expect(answer.url).match(/\/videos\/vid_h264\/hls\/master\.m3u8\?t=/)
    expect(answer.codecs).equals('avc1')
  })

  it('answers it for a video whose files are not there, and null for a row with none', async function () {
    const gone = await playbackAnswer(
      deps,
      {
        id: 'vid_gone',
        storage: 'local',
        kind: 'program',
        durationSec: null,
        spaceSecret: null,
        codecs: 'avc1'
      },
      NOW
    )
    expect(gone.unavailable).equals(true)
    expect(gone.codecs).equals('avc1')
    const older = await playbackAnswer(
      deps,
      {
        id: 'vid_older',
        storage: 'spaces',
        kind: 'program',
        durationSec: 60,
        spaceSecret: null,
        codecs: null
      },
      NOW
    )
    expect(older.codecs).equals(null)
  })

  it('is read from an older server that leaves it out', function () {
    const answer = asPlayback({
      videoId: 'vid_1',
      storage: 'spaces',
      url: 'https://api.example/x.m3u8',
      expiresAt: null,
      durationSec: null,
      unavailable: false
    })
    expect(answer.codecs).equals(undefined)
    expect(
      asPlayback({
        videoId: 'vid_1',
        storage: 'spaces',
        url: null,
        expiresAt: null,
        durationSec: null,
        unavailable: true,
        codecs: 'avc1'
      }).codecs
    ).equals('avc1')
  })
})
