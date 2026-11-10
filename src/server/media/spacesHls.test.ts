import { expect } from 'chai'
import { beforeEach, describe, it } from 'mocha'

import { stalledValkey } from '../../test/stalledValkey'
import {
  mediaBase,
  mediaVariant,
  PlaylistCache,
  rewriteMasterPlaylist,
  rewriteMediaPlaylist,
  spaceConfigured,
  spaceKey,
  SpacePlayback,
  type SpaceSettings
} from './spacesHls'
import type { VideoPath } from './videoPrefix'

const SECRET = '0123456789abcdef0123456789abcdef'

/** A video on its old path, with no secret. */
const old = (id: string): VideoPath => ({ id, spaceSecret: null })

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

  it('names a video’s objects under its secret path, or its id alone with none', function () {
    expect(spaceKey(old('vid_abc'), 'master.m3u8')).equals(
      'videos/vid_abc/master.m3u8'
    )
    expect(
      spaceKey({ id: 'vid_abc', spaceSecret: SECRET }, 'master.m3u8')
    ).equals(`videos/vid_abc-${SECRET}/master.m3u8`)
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

    expect(await cache.get(old('vid_abc'), 'video.m3u8')).equals(MEDIA_PLAYLIST)
    expect(await cache.get(old('vid_abc'), 'video.m3u8')).equals(MEDIA_PLAYLIST)
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

    expect(await cache.get(old('vid_missing'), 'video.m3u8')).equals(undefined)
    expect(await cache.get(old('vid_missing'), 'video.m3u8')).equals(undefined)
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
    const first = cache.get(old('live'), 'index.m3u8', false)
    time += 5000
    const second = cache.get(old('live'), 'index.m3u8', false)
    expect(requests).equals(1)
    release()
    expect(await first).equals(await second)
    await cache.get(old('live'), 'index.m3u8', false)
    expect(requests).equals(1)
    time += 1000
    body = MEDIA_PLAYLIST.replace('#EXT-X-ENDLIST', '')
    expect(await cache.get(old('live'), 'index.m3u8', false)).not.contains(
      '#EXT-X-ENDLIST'
    )
    expect(requests).equals(2)
    body = MEDIA_PLAYLIST
    expect(await cache.get(old('live'), 'index.m3u8', true)).contains(
      '#EXT-X-ENDLIST'
    )
    time += 60_001
    await cache.get(old('other'), 'index.m3u8', false)
    await cache.get(old('live'), 'index.m3u8', true)
    expect(requests).equals(4)
    await cache.get(old('live'), 'video.m3u8', false)
    expect(requests).equals(5)
    cache.playlists.clear()
    await cache.get(old('live'), 'index.m3u8', true)
    expect(requests).equals(6)
  })

  it('memoizes signatures and rewritten bodies for fifteen-minute windows', function () {
    let time = 900_001
    const cache = new SpacePlayback(
      { space: SPACE, expiresSec: 3600 },
      () => time
    )
    const one = cache.sign(old('live'), 'video.mp4')
    const url = new URL(one)
    expect(url.searchParams.get('X-Amz-Date')).equals('19700101T001500Z')
    expect(url.searchParams.get('X-Amz-Expires')).equals('4500')
    const rewritten = cache.rewrite(old('live'), 'video.m3u8', MEDIA_PLAYLIST)
    expect(cache.rewrite(old('live'), 'video.m3u8', MEDIA_PLAYLIST)).equals(
      rewritten
    )
    expect(rewritten.split(one)).length(4)
    time += 899_998
    expect(cache.sign(old('live'), 'video.mp4')).equals(one)
    time += 1
    expect(cache.sign(old('live'), 'video.mp4')).not.equals(one)
    expect(cache.rewrite(old('live'), 'video.m3u8', MEDIA_PLAYLIST)).not.equals(
      rewritten
    )
    expect(cache.sign(old('live'), 'init000012.mp4')).contains('init000012.mp4')
    expect(() => cache.sign(old('live'), 'init12.mp4')).throws('Invalid media')
    expect(() => cache.sign(old('live'), '../other/video.mp4')).throws(
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
    expect(await cache.get(old('live'), 'index.m3u8', false)).equals(undefined)
    time += 1000
    try {
      await cache.get(old('live'), 'index.m3u8', false)
      throw new Error('Expected failure')
    } catch (error) {
      expect(String(error)).contains('disconnected')
    }
    time += 1000
    expect(await cache.get(old('live'), 'index.m3u8', false)).equals(
      MEDIA_PLAYLIST
    )
  })
})
describe('a Space read that hangs', function () {
  /** A fetch that answers only when its signal aborts it. */
  const hanging =
    (calls: { count: number }): typeof fetch =>
    async (_url: unknown, init?: RequestInit) => {
      calls.count++
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason)
        })
      })
    }

  it('rejects a hung finished playlist at its timeout, caching nothing', async function () {
    const calls = { count: 0 }
    let fetcher = hanging(calls)
    const playlists = new PlaylistCache({
      space: SPACE,
      expiresSec: 3600,
      timeoutMs: 50,
      fetch: async (url, init) => await fetcher(url, init)
    })
    try {
      await playlists.get(old('done'), 'video.m3u8')
      throw new Error('Expected failure')
    } catch (error) {
      expect(String(error)).contains('TimeoutError')
    }
    fetcher = async () => new Response(MEDIA_PLAYLIST)
    expect(await playlists.get(old('done'), 'video.m3u8')).equals(
      MEDIA_PLAYLIST
    )
    expect(calls.count).equals(1)
  })

  it('gives each read a deadline by default', async function () {
    let signal: AbortSignal | undefined
    const playlists = new PlaylistCache({
      space: SPACE,
      expiresSec: 3600,
      fetch: async (_url, init) => {
        signal = init?.signal ?? undefined
        return new Response(MEDIA_PLAYLIST)
      }
    })
    await playlists.get(old('done'), 'video.m3u8')
    expect(signal).instanceOf(AbortSignal)
    expect(signal?.aborted).equals(false)
  })
})
describe('media under a secret path', function () {
  const LIVE_BODY =
    '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg000000.m4s\n#EXTINF:4,\nseg000001.m4s\n'
  const video = { id: 'vid_live-1', spaceSecret: SECRET }

  /** Every URI a rewritten playlist lists, maps included. */
  const uris = (body: string): string[] =>
    body
      .split('\n')
      .flatMap(line =>
        line.startsWith('#EXT-X-MAP:')
          ? [/URI="([^"]+)"/.exec(line)?.[1] ?? '']
          : line === '' || line.startsWith('#')
            ? []
            : [line]
      )

  it('lists plain URLs on mediaBaseUrl, with no query string, maps too', function () {
    const playback = new SpacePlayback({
      space: { ...SPACE, mediaBaseUrl: 'https://media.example.test' },
      expiresSec: 3600
    })
    const out = playback.rewrite(video, 'index.m3u8', LIVE_BODY)
    expect(uris(out)).deep.equals([
      `https://media.example.test/videos/vid_live-1-${SECRET}/init.mp4`,
      `https://media.example.test/videos/vid_live-1-${SECRET}/seg000000.m4s`,
      `https://media.example.test/videos/vid_live-1-${SECRET}/seg000001.m4s`
    ])
    expect(out).not.contains('?')
    expect(out).contains('#EXTINF:4,')
  })

  it('rewrites a finished video.mp4 playlist the same way', function () {
    const playback = new SpacePlayback({
      space: { ...SPACE, mediaBaseUrl: 'https://media.example.test/' },
      expiresSec: 3600
    })
    const out = playback.rewrite(video, 'video.m3u8', MEDIA_PLAYLIST)
    const url = `https://media.example.test/videos/vid_live-1-${SECRET}/video.mp4`
    expect(out).contains(`#EXT-X-MAP:URI="${url}",BYTERANGE="3775@0"`)
    expect(out.split('\n').filter(line => line === url)).has.length(2)
    expect(out).contains('#EXT-X-BYTERANGE:267727@3775')
  })

  it('keeps a path in mediaBaseUrl, and uses the bucket’s own base when it is empty', function () {
    const key = `videos/vid_live-1-${SECRET}/seg000000.m4s`
    const sign = (space: SpaceSettings): string =>
      new SpacePlayback({ space, expiresSec: 60 }).sign(video, 'seg000000.m4s')
    expect(
      sign({ ...SPACE, mediaBaseUrl: 'https://cdn.example.test/media/' })
    ).equals(`https://cdn.example.test/media/${key}`)
    expect(sign(SPACE)).equals(
      `https://example-media-bkt.sfo3.digitaloceanspaces.com/${key}`
    )
    expect(sign({ ...SPACE, mediaBaseUrl: '' })).equals(
      `https://example-media-bkt.sfo3.digitaloceanspaces.com/${key}`
    )
    expect(
      sign({ ...SPACE, endpoint: 'http://127.0.0.1:9199', pathStyle: true })
    ).equals(`http://127.0.0.1:9199/example-media-bkt/${key}`)
    expect(
      mediaBase({
        ...SPACE,
        endpoint: 'http://127.0.0.1:9199',
        pathStyle: true
      })
    ).equals('http://127.0.0.1:9199/example-media-bkt')
  })

  it('signs a video with no secret, as before', function () {
    const playback = new SpacePlayback({
      space: { ...SPACE, mediaBaseUrl: 'https://media.example.test' },
      expiresSec: 3600
    })
    const out = playback.rewrite(old('vid_old'), 'index.m3u8', LIVE_BODY)
    for (const uri of uris(out)) {
      const url = new URL(uri)
      expect(url.host).equals('example-media-bkt.sfo3.digitaloceanspaces.com')
      expect(url.pathname).matches(/^\/videos\/vid_old\/(?:init|seg)/)
      expect(url.searchParams.get('X-Amz-Signature')).not.equals(null)
    }
  })

  it('keeps signed URLs for a read-only-source object', function () {
    const readOnlySource = {
      endpoint: 'https://nyc3.digitaloceanspaces.com',
      region: 'nyc3',
      bucket: 'shared-media-bkt',
      accessKeyId: 'AKIAREADONLYEXAMPLE0',
      secretAccessKey: 'readonly',
      keys: ['videos/demo/video.mp4', `videos/vid_live-1-${SECRET}/init.mp4`]
    }
    const playback = new SpacePlayback({
      space: {
        ...SPACE,
        mediaBaseUrl: 'https://media.example.test',
        readOnlySource
      },
      expiresSec: 3600
    })
    const demo = new URL(playback.sign(old('demo'), 'video.mp4'))
    expect(demo.host).equals('shared-media-bkt.nyc3.digitaloceanspaces.com')
    expect(demo.searchParams.get('X-Amz-Signature')).not.equals(null)
    // Even under a secret path, an object the read-only source names is
    // in that other bucket, and not public.
    const listed = new URL(playback.sign(video, 'init.mp4'))
    expect(listed.host).equals('shared-media-bkt.nyc3.digitaloceanspaces.com')
    expect(listed.searchParams.get('X-Amz-Signature')).not.equals(null)
    expect(playback.sign(video, 'seg000000.m4s')).equals(
      `https://media.example.test/videos/vid_live-1-${SECRET}/seg000000.m4s`
    )
  })

  it('reads a secret-path video’s playlists from its secret prefix, signed', async function () {
    const asked: string[] = []
    const playback = new SpacePlayback({
      space: SPACE,
      expiresSec: 3600,
      fetch: async (url: string | URL | Request) => {
        asked.push(url instanceof Request ? url.url : url.toString())
        return new Response(LIVE_BODY)
      }
    })
    await playback.get(video, 'index.m3u8', false)
    await playback.playlists.get(video, 'master.m3u8')
    expect(asked.map(url => new URL(url).pathname)).deep.equals([
      `/videos/vid_live-1-${SECRET}/index.m3u8`,
      `/videos/vid_live-1-${SECRET}/master.m3u8`
    ])
    for (const url of asked) expect(url).contains('X-Amz-Signature=')
  })
})
describe('live playlists when Valkey stalls', function () {
  this.timeout(10000)
  const HEADER =
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n'
  const piece = (n: number): string =>
    `#EXTINF:4,\nseg${String(n).padStart(6, '0')}.m4s\n`
  const body = (count: number): string =>
    HEADER + Array.from({ length: count }, (_, n) => piece(n)).join('')
  const video = { id: 'vid_stall', spaceSecret: SECRET }
  const space = { ...SPACE, mediaBaseUrl: 'https://media.example.test' }
  const prefix = 'ts:stall'

  let time: number
  let logged: string[]
  let valkey: ReturnType<typeof stalledValkey>
  let playback: SpacePlayback
  beforeEach(async function () {
    time = 0
    logged = []
    valkey = stalledValkey(video.id)
    playback = new SpacePlayback(
      {
        space,
        expiresSec: 3600,
        fetch: async () => new Response(body(1))
      },
      () => time,
      {
        client: valkey.client,
        subscriber: valkey.subscriber,
        prefix,
        log: line => logged.push(line)
      }
    )
    // The subscribe's reply.
    await new Promise(resolve => setImmediate(resolve))
  })
  const fromSpace = (): string => playback.rewrite(video, 'index.m3u8', body(1))
  const rewritten = (text: string): string =>
    rewriteMediaPlaylist(text, uri => playback.sign(video, uri))

  it('ignores a late answer, and serves what the next read finds', async function () {
    const stalled = new SpacePlayback(
      { space, expiresSec: 3600, fetch: async () => new Response(body(1)) },
      () => time,
      {
        client: valkey.client,
        subscriber: valkey.subscriber,
        prefix,
        readTimeoutMs: 20,
        log: line => logged.push(line)
      }
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(await stalled.live(video)).equals(fromSpace())
    // A second on, the next request asks Valkey again, and it answers.
    time += 1000
    const next = stalled.live(video)
    await new Promise(resolve => setImmediate(resolve))
    expect(valkey.reloads).length(2)
    valkey.reloads[1].resolve([[body(2)], '2'])
    expect(await next).equals(rewritten(body(2)))
    // The first read's answer, stale, lands after it timed out.
    valkey.reloads[0].resolve([[body(7)], '1'])
    valkey.reloads.length = 0
    await new Promise(resolve => setImmediate(resolve))
    expect(await stalled.live(video)).equals(rewritten(body(2)))
    expect(stalled.following?.size).equals(1)
    expect(valkey.reloads).length(0)
  })

  it('drops a copy whose update stalls, and ignores its late entries', async function () {
    const stalled = new SpacePlayback(
      { space, expiresSec: 3600, fetch: async () => new Response(body(1)) },
      () => time,
      {
        client: valkey.client,
        subscriber: valkey.subscriber,
        prefix,
        readTimeoutMs: 20,
        log: line => logged.push(line)
      }
    )
    await new Promise(resolve => setImmediate(resolve))
    const first = stalled.live(video)
    await new Promise(resolve => setImmediate(resolve))
    valkey.reloads[0].resolve([[body(2)], '3'])
    expect(await first).equals(rewritten(body(2)))
    valkey.notify(3, 3)
    await new Promise(resolve => setImmediate(resolve))
    // The update's read of the new entries and the generation, one MULTI.
    expect(valkey.reloads).length(2)
    expect(await stalled.live(video)).equals(fromSpace())
    expect(stalled.following?.size).equals(0)
    // It answers late, on a copy nobody holds: not applied.
    valkey.reloads[1].resolve([[piece(2)], '3'])
    await new Promise(resolve => setImmediate(resolve))
    time += 1000
    const again = stalled.live(video)
    await new Promise(resolve => setImmediate(resolve))
    expect(valkey.reloads).length(3)
    valkey.reloads[2].resolve([[body(4)], '4'])
    expect(await again).equals(rewritten(body(4)))
    // Logged once a minute per video, however many reads stall.
    time += 1000
    valkey.notify(5, 4)
    await stalled.live(video)
    expect(logged).length(1)
    time += 60_000
    await stalled.live(video)
    await stalled.live({ id: 'vid_other', spaceSecret: SECRET })
    expect(logged).length(3)
  })

  it('ignores a late failure of a copy it already dropped', async function () {
    const stalled = new SpacePlayback(
      { space, expiresSec: 3600, fetch: async () => new Response(body(1)) },
      () => time,
      {
        client: valkey.client,
        subscriber: valkey.subscriber,
        prefix,
        readTimeoutMs: 20,
        log: line => logged.push(line)
      }
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(await stalled.live(video)).equals(fromSpace())
    time += 1000
    const next = stalled.live(video)
    await new Promise(resolve => setImmediate(resolve))
    valkey.reloads[1].resolve([[body(3)], '1'])
    expect(await next).equals(rewritten(body(3)))
    valkey.reloads[0].reject(new Error('connection reset'))
    await new Promise(resolve => setImmediate(resolve))
    // Still served from the copy, with no second of Space reads.
    expect(await stalled.live(video)).equals(rewritten(body(3)))
    expect(logged).length(1)
  })
})
