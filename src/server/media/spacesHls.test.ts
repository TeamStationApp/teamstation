import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  PlaylistCache,
  rewriteMasterPlaylist,
  rewriteMediaPlaylist,
  spaceConfigured,
  spaceKey
} from './spacesHls'

const SPACE = {
  endpoint: 'https://sfo3.digitaloceanspaces.com',
  region: 'sfo3',
  bucket: 'teamstation-media',
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
      'https://teamstation-media.sfo3.digitaloceanspaces.com/videos/vid_abc/video.m3u8?'
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
