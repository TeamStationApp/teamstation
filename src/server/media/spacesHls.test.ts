import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  mediaVariant,
  PlaylistCache,
  rewriteMasterPlaylist,
  rewriteMediaPlaylist,
  spaceConfigured,
  spaceKey,
  SpacePlayback
} from './spacesHls'

const SPACE = {
  endpoint: 'https://sfo3.digitaloceanspaces.com',
  region: 'sfo3',
  bucket: 'example-media-bkt',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
}

// What the remux actually writes, copied from a real run.
const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="video.mp4",BYTERANGE="3775@0"
#EXTINF:6.000000,
#EXT-X-BYTERANGE:267727@3775
video.mp4
#EXTINF:6.000000,
#EXT-X-BYTERANGE:265119@271502
video.mp4
#EXT-X-ENDLIST
`

const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=364617,RESOLUTION=1280x720,CODECS="hvc1.1.6.L93.90,mp4a.40.2"
video.m3u8
`

describe('serving HLS out of a Space', function () {
  it('is not attempted without a key', function () {
    expect(spaceConfigured(SPACE)).equals(true)
    expect(spaceConfigured({ ...SPACE, accessKeyId: '' })).equals(false)
    expect(spaceConfigured({ ...SPACE, secretAccessKey: '' })).equals(false)
    expect(spaceConfigured({ ...SPACE, bucket: '' })).equals(false)
  })

  it('names objects by video id alone', function () {
    expect(spaceKey('vid_abc', 'master.m3u8')).equals(
      'videos/vid_abc/master.m3u8'
    )
  })

  it('points every reference to the video at the presigned URL', function () {
    const signed = 'https://space.example/video.mp4?X-Amz-Signature=abc'
    const out = rewriteMediaPlaylist(MEDIA_PLAYLIST, 'video.mp4', signed)

    // Both the init map and each byte-range entry.
    expect(out).contains(`#EXT-X-MAP:URI="${signed}",BYTERANGE="3775@0"`)
    expect(out.split('\n').filter(line => line === signed)).has.length(2)
    // Nothing may still refer to the bare name.
    expect(out).does.not.match(/^video\.mp4$/m)

    // The ranges and durations are the muxer's and must be untouched.
    expect(out).contains('#EXT-X-BYTERANGE:267727@3775')
    expect(out).contains('#EXT-X-BYTERANGE:265119@271502')
    expect(out).contains('#EXTINF:6.000000,')
    expect(out).contains('#EXT-X-ENDLIST')
  })

  it('keeps the token on the variant a master playlist points to', function () {
    const variant =
      'https://tube2.example/api/v1/videos/v1/hls/video.m3u8?t=9.x'
    const out = rewriteMasterPlaylist(MASTER_PLAYLIST, variant)
    expect(out).contains(variant)
    expect(out).does.not.match(/^video\.m3u8$/m)
    // The stream information line is the player's, not ours to touch.
    expect(out).contains('CODECS="hvc1.1.6.L93.90,mp4a.40.2"')
  })

  it('fetches a playlist once and then remembers it', async function () {
    let calls = 0
    let lastUrl = ''
    const cache = new PlaylistCache({
      space: SPACE,
      expiresSec: 3600,
      fetch: (async (url: string) => {
        calls += 1
        lastUrl = String(url)
        return { ok: true, text: async () => MEDIA_PLAYLIST }
      }) as unknown as typeof fetch
    })

    expect(await cache.get('vid_abc', 'video.m3u8')).equals(MEDIA_PLAYLIST)
    expect(await cache.get('vid_abc', 'video.m3u8')).equals(MEDIA_PLAYLIST)
    expect(calls).equals(1)
    expect(lastUrl).contains(
      'https://example-media-bkt.sfo3.digitaloceanspaces.com/videos/vid_abc/video.m3u8?'
    )
    expect(lastUrl).contains('X-Amz-Signature=')
  })

  it('does not cache a playlist that was not there', async function () {
    let calls = 0
    const cache = new PlaylistCache({
      space: SPACE,
      expiresSec: 3600,
      fetch: (async () => {
        calls += 1
        return { ok: false, text: async () => '' }
      }) as unknown as typeof fetch
    })

    expect(await cache.get('vid_missing', 'video.m3u8')).equals(undefined)
    expect(await cache.get('vid_missing', 'video.m3u8')).equals(undefined)
    expect(calls).equals(2)
  })
})

describe('live Space playback cache', function () {
  it('rewrites every fragment and init URI while preserving timing tags', function () {
    const body =
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\nseg000000.m4s\n#EXTINF:3,\nseg000001.m4s\n'
    const result = rewriteMediaPlaylist(
      body,
      uri => `https://objects.example.test/${uri}?signed=1`
    )
    expect(result).contains(
      'URI="https://objects.example.test/init.mp4?signed=1"'
    )
    expect(result).contains(
      '#EXT-X-DISCONTINUITY\n#EXTINF:4,\nhttps://objects.example.test/seg000000.m4s?signed=1'
    )
    expect(result).contains(
      '#EXTINF:3,\nhttps://objects.example.test/seg000001.m4s?signed=1'
    )
  })

  it('recognizes only the two supported single variants', function () {
    expect(mediaVariant(MASTER_PLAYLIST)).equals('video.m3u8')
    expect(
      mediaVariant(MASTER_PLAYLIST.replace('video.m3u8', 'index.m3u8'))
    ).equals('index.m3u8')
    expect(mediaVariant('#EXTM3U\n')).equals(undefined)
    expect(mediaVariant('#EXTM3U\n../wrong.m3u8\n')).equals(undefined)
  })

  it('shares slow reads, refreshes grace closes, and caches only verified finals', async function () {
    let time = 900_000
    let requests = 0
    let release!: () => void
    let body = MEDIA_PLAYLIST
    const cache = new SpacePlayback(
      {
        space: SPACE,
        expiresSec: 3600,
        fetch: async () => {
          requests++
          if (requests === 1)
            await new Promise<void>(resolve => {
              release = resolve
            })
          return new Response(body)
        }
      },
      () => time
    )
    const first = cache.get('live', 'index.m3u8', false)
    time += 5000
    const second = cache.get('live', 'index.m3u8', false)
    expect(requests).equals(1)
    release()
    expect(await first).equals(await second)
    await cache.get('live', 'index.m3u8', false)
    expect(requests).equals(1)
    time += 1000
    body = MEDIA_PLAYLIST.replace('#EXT-X-ENDLIST', '')
    expect(await cache.get('live', 'index.m3u8', false)).not.contains(
      '#EXT-X-ENDLIST'
    )
    expect(requests).equals(2)
    body = MEDIA_PLAYLIST
    expect(await cache.get('live', 'index.m3u8', true)).contains(
      '#EXT-X-ENDLIST'
    )
    time += 60_001
    await cache.get('other', 'index.m3u8', false)
    await cache.get('live', 'index.m3u8', true)
    expect(requests).equals(4)
    await cache.get('live', 'video.m3u8', false)
    expect(requests).equals(5)
    cache.playlists.clear()
    await cache.get('live', 'index.m3u8', true)
    expect(requests).equals(6)
  })

  it('memoizes signatures and rewritten bodies for fifteen-minute windows', function () {
    let time = 900_001
    const cache = new SpacePlayback(
      { space: SPACE, expiresSec: 3600 },
      () => time
    )
    const one = cache.sign('live', 'video.mp4')
    const url = new URL(one)
    expect(url.searchParams.get('X-Amz-Date')).equals('19700101T001500Z')
    expect(url.searchParams.get('X-Amz-Expires')).equals('4500')
    const rewritten = cache.rewrite('live', 'video.m3u8', MEDIA_PLAYLIST)
    expect(cache.rewrite('live', 'video.m3u8', MEDIA_PLAYLIST)).equals(
      rewritten
    )
    expect(rewritten.split(one)).length(4)
    time += 899_998
    expect(cache.sign('live', 'video.mp4')).equals(one)
    time += 1
    expect(cache.sign('live', 'video.mp4')).not.equals(one)
    expect(cache.rewrite('live', 'video.m3u8', MEDIA_PLAYLIST)).not.equals(
      rewritten
    )
    expect(() => cache.sign('live', '../other/video.mp4')).throws(
      'Invalid media'
    )
  })

  it('retries missing or failed live reads after the refresh interval', async function () {
    let time = 0
    let calls = 0
    const cache = new SpacePlayback(
      {
        space: SPACE,
        expiresSec: 3600,
        fetch: async () => {
          if (++calls === 1) return new Response('missing', { status: 404 })
          if (calls === 2) throw new Error('disconnected')
          return new Response(MEDIA_PLAYLIST)
        }
      },
      () => time
    )
    expect(await cache.get('live', 'index.m3u8', false)).equals(undefined)
    time += 1000
    try {
      await cache.get('live', 'index.m3u8', false)
      throw new Error('Expected failure')
    } catch (error) {
      expect(String(error)).contains('disconnected')
    }
    time += 1000
    expect(await cache.get('live', 'index.m3u8', false)).equals(MEDIA_PLAYLIST)
  })
})
