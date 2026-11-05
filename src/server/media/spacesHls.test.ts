import { expect } from 'chai'
import { afterEach, before, beforeEach, describe, it } from 'mocha'

import {
  connectedClient,
  dropPrefix,
  quiet,
  requireRedis,
  testPrefix,
  testRedisUrl
} from '../../test/scoreboardKit'
import {
  makeScoreboardClient,
  makeScoreboardSubscriber,
  quit,
  type ScoreboardClient
} from '../scoreboard/scoreboardStore'
import {
  livePlaylistChannel,
  livePlaylistGenKey,
  livePlaylistKey,
  parseLivePlaylistNotice,
  ValkeyPlaylistSink
} from './livePlaylists'
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

describe('live playlists through Valkey', function () {
  this.timeout(30000)
  const HEADER =
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n'
  const piece = (n: number): string =>
    `#EXTINF:4,\nseg${String(n).padStart(6, '0')}.m4s\n`
  const body = (count: number): string =>
    HEADER + Array.from({ length: count }, (_, n) => piece(n)).join('')
  const video = { id: 'vid_follow', spaceSecret: SECRET }
  const space = { ...SPACE, mediaBaseUrl: 'https://media.example.test' }

  let prefix = ''
  let client: ScoreboardClient
  let reader: ScoreboardClient
  let subscriber: ScoreboardClient
  let sink: ValkeyPlaylistSink
  let spaceReads: number
  let enabled: boolean
  /** Every list read the worker made: LRANGE ranges, and whole reloads. */
  let ranges: Array<[number, number]>
  let reloads: number
  let signed: number
  let playback: SpacePlayback
  const logged: string[] = []

  before(async function () {
    await requireRedis()
  })
  beforeEach(async function () {
    prefix = testPrefix()
    client = await connectedClient()
    reader = await connectedClient()
    subscriber = makeScoreboardSubscriber(reader, quiet)
    await subscriber.connect()
    await subscriber.clientSetName(`${prefix.replace(':', '-')}-sub`)
    sink = new ValkeyPlaylistSink(client, prefix, line => logged.push(line))
    spaceReads = 0
    enabled = true
    ranges = []
    reloads = 0
    signed = 0
    const lRange = reader.lRange.bind(reader)
    ;(reader as { lRange: unknown }).lRange = async (
      key: string,
      start: number,
      stop: number
    ) => {
      ranges.push([start, stop])
      return await lRange(key, start, stop)
    }
    const multi = reader.multi.bind(reader)
    ;(reader as { multi: unknown }).multi = () => {
      reloads++
      return multi()
    }
    playback = followingPlayback()
    const sign = playback.sign.bind(playback)
    playback.sign = (path, uri) => {
      signed++
      return sign(path, uri)
    }
    await following()
  })
  afterEach(async function () {
    await quit(subscriber)
    await quit(reader)
    await quit(client)
    await dropPrefix(prefix)
  })

  function followingPlayback(
    clients: { client: ScoreboardClient; subscriber: ScoreboardClient } = {
      client: reader,
      subscriber
    },
    now?: () => number
  ): SpacePlayback {
    return new SpacePlayback(
      {
        space,
        expiresSec: 3600,
        fetch: async () => {
          spaceReads++
          return new Response(body(1))
        }
      },
      now,
      { ...clients, prefix, enabled: () => enabled }
    )
  }
  /** The subscription is in place: a notice published now is heard. */
  async function following(target = playback): Promise<void> {
    await until(
      'subscribed',
      async () =>
        (
          await client.sendCommand([
            'PUBSUB',
            'NUMSUB',
            livePlaylistChannel(prefix)
          ])
        )[1] > 0 && target.following != null
    )
    // The subscribe's own reply lands just after the server counts it.
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  async function until(
    what: string,
    check: () => Promise<boolean> | boolean
  ): Promise<void> {
    const deadline = Date.now() + 5000
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const rewritten = (text: string): string =>
    rewriteMediaPlaylist(text, uri => playback.sign(video, uri))
  const served = async (): Promise<string | undefined> =>
    await playback.live(video)
  const gen = async (): Promise<number> =>
    Number(await client.get(livePlaylistGenKey(prefix, video.id)))

  it('keeps the list, its generation and its notices under the prefix', async function () {
    await sink.replace(video.id, body(1))
    await sink.append(video.id, piece(1), body(2))
    const key = livePlaylistKey(prefix, video.id)
    expect(key).equals(`${prefix}:live:playlist:vid_follow`)
    expect(await client.lRange(key, 0, -1)).deep.equals([body(1), piece(1)])
    expect(await gen()).equals(1)
    const ttl = await client.ttl(key)
    expect(ttl).within(12 * 3600 - 5, 12 * 3600)
    expect(await client.ttl(livePlaylistGenKey(prefix, video.id))).within(
      12 * 3600 - 5,
      12 * 3600
    )
    expect(parseLivePlaylistNotice('{"v":"vid_x","n":2,"g":3}')).deep.equals({
      v: 'vid_x',
      n: 2,
      g: 3
    })
    expect(parseLivePlaylistNotice('{"v":"vid_x"}')).equals(undefined)
    expect(parseLivePlaylistNotice('not json')).equals(undefined)
  })

  it('reads only the entries a notice adds, and rewrites only their lines', async function () {
    await sink.replace(video.id, body(2))
    const first = await served()
    // The map and two pieces, each signed once.
    expect(signed).equals(3)
    expect(first).equals(rewritten(body(2)))
    expect(reloads).equals(1)
    signed = 0
    // Three pieces pushed at once, announced in one notice 3 beyond.
    const key = livePlaylistKey(prefix, video.id)
    await client.rPush(key, [piece(2), piece(3), piece(4)])
    await client.publish(
      livePlaylistChannel(prefix),
      JSON.stringify({ v: video.id, n: 4, g: await gen() })
    )
    await until('the three entries', () => ranges.length === 1)
    const next = await served()
    expect(ranges).deep.equals([[1, 3]])
    expect(signed).equals(3)
    expect(next).equals(rewritten(body(5)))
    expect(reloads).equals(1)
    expect(spaceReads).equals(0)
  })

  it('serves a replaced list after a reconnect rewrote the header', async function () {
    await sink.replace(video.id, body(3))
    expect(await served()).equals(rewritten(body(3)))
    const before = await gen()
    const replaced = body(3) + '#EXT-X-DISCONTINUITY\n' + piece(3)
    // A body that does not extend the last: n 1, a new g.
    await sink.replace(video.id, replaced.replace('VERSION:7', 'VERSION:8'))
    expect(await gen()).equals(before + 1)
    await until('the reload', () => reloads === 2)
    expect(await served()).equals(
      rewritten(replaced.replace('VERSION:7', 'VERSION:8'))
    )
    // A notice below the count, on the same generation, reloads as well.
    await client.publish(
      livePlaylistChannel(prefix),
      JSON.stringify({ v: video.id, n: 0, g: await gen() })
    )
    await until('another reload', () => reloads === 3)
    expect(spaceReads).equals(0)
  })

  it('replaces the whole body with a new generation when the list went missing mid-game', async function () {
    await sink.replace(video.id, body(2))
    await sink.append(video.id, piece(2), body(3))
    expect(await served()).equals(rewritten(body(3)))
    const before = await gen()
    const key = livePlaylistKey(prefix, video.id)
    await client.del(key)
    await sink.append(video.id, piece(3), body(4))
    // Its push answered 1, not 4: the whole body, as one entry.
    expect(await client.lRange(key, 0, -1)).deep.equals([body(4)])
    expect(await gen()).equals(before + 1)
    await until('the reload', () => reloads === 2)
    expect(await served()).equals(rewritten(body(4)))
    expect(spaceReads).equals(0)
  })

  it('starts a list again when a push came before any replacement in this process', async function () {
    await sink.append(video.id, piece(1), body(2))
    expect(
      await client.lRange(livePlaylistKey(prefix, video.id), 0, -1)
    ).deep.equals([body(2)])
  })

  it('never fails a flush on a Valkey failure, and starts the list again after it', async function () {
    const broken = makeScoreboardClient('redis://127.0.0.1:1', quiet)
    const failing = new ValkeyPlaylistSink(broken, prefix, line =>
      logged.push(line)
    )
    logged.length = 0
    await failing.replace(video.id, body(1))
    await failing.append(video.id, piece(1), body(2))
    await failing.forget(video.id)
    expect(logged).length(1)
    // A working sink says when Valkey answers again.
    const recovering = new ValkeyPlaylistSink(client, prefix, line =>
      logged.push(line)
    )
    ;(recovering as unknown as { down: boolean }).down = true
    await recovering.replace(video.id, body(1))
    expect(logged.at(-1)).equals('live playlists: Valkey answers again')
  })

  it('deletes a closed list on forget, and falls back to the Space once it has gone', async function () {
    let time = 0
    const clocked = followingPlayback(undefined, () => time)
    await following(clocked)
    await sink.replace(video.id, body(2) + '#EXT-X-ENDLIST\n')
    expect(await clocked.live(video)).contains('#EXT-X-ENDLIST')
    await sink.forget(video.id)
    expect(await client.exists(livePlaylistKey(prefix, video.id))).equals(0)
    // Kept for a minute after it closed, then read again: from the Space.
    time += 30_000
    expect(await clocked.live(video)).contains('#EXT-X-ENDLIST')
    expect(spaceReads).equals(0)
    time += 31_000
    expect(await clocked.live(video)).equals(
      clocked.rewrite(video, 'index.m3u8', body(1))
    )
    expect(spaceReads).equals(1)
    // The missing list is asked about again only after a second.
    const asked = reloads
    expect(await clocked.live(video)).not.equals(undefined)
    expect(reloads).equals(asked)
    time += 1000
    await clocked.live(video)
    expect(reloads).equals(asked + 1)
    expect(spaceReads).equals(2)
  })

  it('drops a copy nobody asked for in ten minutes', async function () {
    let time = 0
    const clocked = followingPlayback(undefined, () => time)
    await following(clocked)
    await sink.replace(video.id, body(2))
    await clocked.live(video)
    expect(clocked.following?.size).equals(1)
    time += 10 * 60_000 + 1
    await clocked.live({ id: 'vid_other', spaceSecret: SECRET })
    expect(clocked.following?.size).equals(0)
  })

  it('reads the Space at most once a second for each video with no Valkey', async function () {
    let time = 0
    const absent = makeScoreboardClient('redis://127.0.0.1:1', quiet)
    const offline = followingPlayback(
      { client: absent, subscriber: absent },
      () => time
    )
    const other = { id: 'vid_other', spaceSecret: SECRET }
    for (let n = 0; n < 5; n++) {
      expect(await offline.live(video)).equals(
        offline.rewrite(video, 'index.m3u8', body(1))
      )
      await offline.live(other)
    }
    expect(spaceReads).equals(2)
    time += 1000
    await offline.live(video)
    expect(spaceReads).equals(3)
    // A connected worker before its feed is filled does the same.
    enabled = false
    await sink.replace(video.id, body(2))
    spaceReads = 0
    for (let n = 0; n < 5; n++) await served()
    expect(spaceReads).equals(1)
    expect(reloads).equals(0)
  })

  it('follows once connections it was handed still connecting have come up, as a worker’s are', async function () {
    const command = makeScoreboardClient(testRedisUrl, quiet)
    const listener = makeScoreboardSubscriber(command, quiet)
    const connecting = Promise.all([command.connect(), listener.connect()])
    const early = followingPlayback({ client: command, subscriber: listener })
    try {
      await connecting
      await following(early)
      await until('following', () => early.following?.size === 0)
      await sink.replace(video.id, body(2))
      expect(await early.live(video)).equals(rewritten(body(2)))
      expect(spaceReads).equals(0)
      expect(early.following?.size).equals(1)
    } finally {
      await quit(listener)
      await quit(command)
    }
  })

  it('drops its copies when its subscriber reconnects, and reads the list again', async function () {
    await sink.replace(video.id, body(2))
    await served()
    expect(playback.following?.size).equals(1)
    const name = `${prefix.replace(':', '-')}-sub`
    const list = await client.sendCommand(['CLIENT', 'LIST'])
    const id = (typeof list === 'string' ? list : '')
      .split('\n')
      .find(line => line.includes(` name=${name} `))
      ?.match(/^id=(\d+)/)?.[1]
    expect(id, name).is.a('string')
    // The kill and a push go out together, so the notice is missed.
    await Promise.all([
      client.sendCommand(['CLIENT', 'KILL', 'ID', id ?? '']),
      sink.append(video.id, piece(2), body(3))
    ])
    await until('the copy dropped', () => playback.following?.size === 0)
    await until('subscribed again', () => subscriber.isReady)
    await following()
    expect(await served()).equals(rewritten(body(3)))
    expect(reloads).equals(2)
    expect(spaceReads).equals(0)
  })

  it('signs again a copy of a video with no secret once its window turns', async function () {
    let time = 0
    const clocked = followingPlayback(undefined, () => time)
    await following(clocked)
    const unsecret = { id: 'vid_follow', spaceSecret: null }
    await sink.replace(video.id, body(1))
    const first = await clocked.live(unsecret)
    expect(first).contains('X-Amz-Signature=')
    expect(await clocked.live(unsecret)).equals(first)
    time += 15 * 60_000
    const later = await clocked.live(unsecret)
    expect(later).not.equals(first)
    expect(reloads).equals(2)
  })
})
