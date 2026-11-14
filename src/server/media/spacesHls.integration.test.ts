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
import { type Pending, stalledValkey } from '../../test/stalledValkey'
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
import { rewriteMediaPlaylist, SpacePlayback } from './spacesHls'
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

  it('rejects the shared open read at its timeout, and the next request reads again', async function () {
    let time = 0
    const calls = { count: 0 }
    let fetcher = hanging(calls)
    const cache = new SpacePlayback(
      {
        space: SPACE,
        expiresSec: 3600,
        timeoutMs: 50,
        fetch: async (url, init) => await fetcher(url, init)
      },
      () => time
    )
    const started = Date.now()
    const viewers = [
      cache.live(old('live')),
      cache.live(old('live')),
      cache.get(old('live'), 'index.m3u8', false)
    ]
    const outcomes = await Promise.allSettled(viewers)
    expect(Date.now() - started).below(1000)
    expect(calls.count).equals(1)
    for (const outcome of outcomes) {
      expect(outcome.status).equals('rejected')
      expect(String((outcome as PromiseRejectedResult).reason)).contains(
        'TimeoutError'
      )
    }
    // Retried as a failed read is: after the refresh interval.
    time += 1000
    fetcher = async () => new Response(MEDIA_PLAYLIST)
    expect(await cache.get(old('live'), 'index.m3u8', false)).equals(
      MEDIA_PLAYLIST
    )
    expect(calls.count).equals(1)
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
    // A MULTI that reads the whole list is a reload; one that reads a range
    // of it is an update, as a bare LRANGE was.
    const multi = reader.multi.bind(reader)
    ;(reader as { multi: unknown }).multi = () => {
      const real = multi()
      const inner = real.lRange.bind(real)
      ;(real as { lRange: unknown }).lRange = (
        key: string,
        start: number,
        stop: number
      ) => {
        if (start === 0 && stop === -1) reloads++
        else ranges.push([start, stop])
        return inner(key, start, stop)
      }
      return real
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
    await until('subscribed', async () => {
      const reply: unknown = await client.sendCommand([
        'PUBSUB',
        'NUMSUB',
        livePlaylistChannel(prefix)
      ])
      return (
        Array.isArray(reply) && Number(reply[1]) > 0 && target.following != null
      )
    })
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

  it('reloads, not appends, when a stale notice meets a list replaced and grown past it', async function () {
    await sink.replace(video.id, body(2))
    expect(await served()).equals(rewritten(body(2)))
    const stale = await gen()
    // The list replaced and grown, its own notices not yet heard.
    const key = livePlaylistKey(prefix, video.id)
    const replaced = body(2).replace('VERSION:7', 'VERSION:8')
    await client
      .multi()
      .del(key)
      .rPush(key, [replaced, piece(2), piece(3), piece(4)])
      .incr(livePlaylistGenKey(prefix, video.id))
      .exec()
    await client.publish(
      livePlaylistChannel(prefix),
      JSON.stringify({ v: video.id, n: 4, g: stale })
    )
    await until('the reload', () => reloads === 2)
    expect(await served()).equals(
      rewritten(replaced + piece(2) + piece(3) + piece(4))
    )
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

  it('signs a later part’s map in the text a push adds', async function () {
    await sink.replace(video.id, body(2))
    const part =
      '#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="init000002.mp4"\n' + piece(2)
    await sink.append(video.id, part, body(2) + part)
    await until(
      'the part',
      async () => (await served()) === rewritten(body(2) + part)
    )
    expect(await served()).contains(
      `URI="https://media.example.test/videos/${video.id}-${SECRET}/init000002.mp4"`
    )
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

  it('reads the Space while an open list has not grown in 15 s, and Valkey again once it grows', async function () {
    let time = 0
    const clocked = followingPlayback(undefined, () => time)
    await following(clocked)
    const fromSpace = clocked.rewrite(video, 'index.m3u8', body(1))
    await sink.replace(video.id, body(2))
    const copy = rewriteMediaPlaylist(body(2), uri => clocked.sign(video, uri))
    expect(await clocked.live(video)).equals(copy)
    time += 15_000
    expect(await clocked.live(video)).equals(copy)
    expect(spaceReads).equals(0)
    // The ingest stopped reaching Valkey; this worker did not.
    time += 1
    expect(await clocked.live(video)).equals(fromSpace)
    expect(spaceReads).equals(1)
    // A subscriber reconnect reads the same list again: not growth.
    clocked.following!.drop()
    time += 1000
    expect(await clocked.live(video)).equals(fromSpace)
    // Once it grows, the copy is served again.
    await sink.append(video.id, piece(2), body(3))
    const grown = rewriteMediaPlaylist(body(3), uri => clocked.sign(video, uri))
    await until('the growth', async () => (await clocked.live(video)) === grown)
    // A closed list never grows, and is served until it goes.
    await sink.append(
      video.id,
      '#EXT-X-ENDLIST\n',
      body(3) + '#EXT-X-ENDLIST\n'
    )
    await until(
      'the close',
      async () =>
        (await clocked.live(video))?.includes('#EXT-X-ENDLIST') === true
    )
    const reads = spaceReads
    time += 30_000
    expect(await clocked.live(video)).contains('#EXT-X-ENDLIST')
    expect(spaceReads).equals(reads)
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
  let spaceReads: number
  let logged: string[]
  let valkey: ReturnType<typeof stalledValkey>
  let playback: SpacePlayback
  beforeEach(async function () {
    time = 0
    spaceReads = 0
    logged = []
    valkey = stalledValkey(video.id)
    playback = new SpacePlayback(
      {
        space,
        expiresSec: 3600,
        fetch: async () => {
          spaceReads++
          return new Response(body(1))
        }
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

  it('answers from the Space within about a second when Valkey does not', async function () {
    const started = Date.now()
    const viewers = await Promise.all([
      playback.live(video),
      playback.live(video)
    ])
    const took = Date.now() - started
    expect(took).within(900, 1500)
    expect(viewers).deep.equals([fromSpace(), fromSpace()])
    expect(spaceReads).equals(1)
    expect(valkey.reloads).length(1)
    // The copy is gone, and Valkey is not asked again for a second.
    expect(playback.following?.size).equals(0)
    const quick = Date.now()
    expect(await playback.live(video)).equals(fromSpace())
    expect(Date.now() - quick).below(500)
    expect(valkey.reloads).length(1)
    expect(logged).deep.equals([
      'live playlists: Valkey did not answer for vid_stall in 1000 ms; reading the Space'
    ])
  })

  it('goes on with a flush when the sink’s Valkey stalls, sends nothing more until it answers, then replaces the list', async function () {
    // Each MULTI waits until the test settles it; every command is counted.
    const execs: Array<Pending<unknown[]>> = []
    const sent: string[] = []
    const multi: Record<string, (...args: unknown[]) => unknown> = {
      del: () => {
        sent.push('del')
        return multi
      },
      rPush: () => {
        sent.push('rPush')
        return multi
      },
      expire: () => multi,
      incr: () => multi,
      exec: async () =>
        await new Promise<unknown[]>((resolve, reject) => {
          execs.push({ resolve, reject })
        })
    }
    const published: string[] = []
    const client = {
      multi: () => multi,
      publish: async (_channel: string, message: string) => {
        published.push(message)
      }
    } as unknown as ScoreboardClient
    const sink = new ValkeyPlaylistSink(
      client,
      prefix,
      line => logged.push(line),
      100
    )
    let started = Date.now()
    await sink.replace(video.id, body(1))
    expect(Date.now() - started).within(90, 400)
    expect(logged).deep.equals([
      'live playlists: Valkey did not answer in 100 ms; sending nothing until it does'
    ])
    // Nothing more is sent behind the stalled call, and no flush waits.
    started = Date.now()
    await sink.append(video.id, piece(1), body(2))
    await sink.replace('vid_other', body(1))
    expect(Date.now() - started).below(50)
    expect(execs).length(1)
    // The stalled call answers late: what it wrote is not trusted.
    execs[0].resolve([1, 1, 1, 7, 1])
    await new Promise(resolve => setImmediate(resolve))
    sent.length = 0
    const appending = sink.append(video.id, piece(2), body(3))
    await new Promise(resolve => setImmediate(resolve))
    expect(sent).deep.equals(['del', 'rPush'])
    execs[1].resolve([1, 1, 1, 8, 1])
    await appending
    expect(published.at(-1)).equals(JSON.stringify({ v: video.id, n: 1, g: 8 }))
    expect(logged.at(-1)).equals('live playlists: Valkey answers again')
  })
})
