import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Router } from 'express'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import pg from 'pg'

import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import {
  connectedClient,
  dropPrefix,
  quiet,
  requireRedis,
  testPrefix
} from '../../test/scoreboardKit'
import type { ChangeFeed, FeedHandlers } from '../changeFeed/feed'
import { PostgresFeed } from '../changeFeed/postgresFeed'
import type { Database } from '../db/database'
import { startFakeSpace } from '../dev/fakeSpace'
import {
  beganPublishing,
  drainPublishForTest,
  finishStream,
  type LiveControllerOptions
} from '../live/controller'
import { originFixture } from '../live/originFixtures'
import { OriginPublisher } from '../live/originPublisher'
import {
  livePlaylistGenKey,
  livePlaylistKey,
  ValkeyPlaylistSink
} from '../media/livePlaylists'
import { FeedHolder, type MediaContext } from '../media/mediaContext'
import { MEDIA_TOKEN_TTL_SEC, signQueryToken } from '../media/mediaTokens'
import { rewriteMediaPlaylist, SpacePlayback } from '../media/spacesHls'
import { videoPrefix } from '../media/videoPrefix'
import {
  makeScoreboardSubscriber,
  quit,
  type ScoreboardClient
} from '../scoreboard/scoreboardStore'
import { HLS_ROW_TTL_MS, hlsRowCache, mediaRoutes } from './media'

const SECRET = '0123456789abcdef0123456789abcdef'
const PROGRAMME_SECRET = 'fedcba9876543210fedcba9876543210'
const header =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n'
const segment = (n: number): string => `seg${String(n).padStart(6, '0')}.m4s`
const playlist = (count: number): string =>
  header +
  Array.from({ length: count }, (_, n) => `#EXTINF:4,\n${segment(n)}\n`).join(
    ''
  )

/**
 * The same database as `db`, through a pool that records every statement and,
 * while `refuse.on`, refuses any `pg_notify`.
 */
async function watchedDatabase(db: Kysely<Database>): Promise<{
  db: Kysely<Database>
  url: string
  statements: string[]
  notifies: string[]
  /** Whether a `pg_notify` is refused (and recorded) or let through. */
  refuse: { on: boolean }
}> {
  const { rows } = await sql<{
    name: string
  }>`select current_database() as name`.execute(db)
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${rows[0].name}`)
  const statements: string[] = []
  const notifies: string[] = []
  const refuse = { on: true }
  class Watched extends pg.Client {
    // pg's overloads; only the text is looked at.
    query(...args: any[]): any {
      const text =
        typeof args[0] === 'string' ? args[0] : (args[0]?.text as string)
      if (typeof text === 'string') {
        statements.push(text)
        if (refuse.on && /pg_notify/i.test(text)) {
          notifies.push(text)
          throw new Error('No pg_notify here')
        }
      }
      return (super.query as (...rest: any[]) => any)(...args)
    }
  }
  const pool = new pg.Pool({ connectionString: url, Client: Watched })
  return {
    db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
    url,
    statements,
    notifies,
    refuse
  }
}

/** The route's own read of a video row. */
const rowReads = (statements: string[]): number =>
  statements.filter(text =>
    text.startsWith(
      'select "hidden", "storage", "spaces_verified_at", "space_secret" from "videos"'
    )
  ).length

async function until(
  what: string,
  check: () => Promise<boolean> | boolean,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('the playlist route, through Valkey and a row cache', function () {
  this.timeout(60000)
  let f: GroupFixture
  let root: string
  let media: MediaContext
  let store: Awaited<ReturnType<typeof startFakeSpace>>
  let watched: Awaited<ReturnType<typeof watchedDatabase>>
  let feed: PostgresFeed
  let prefix: string
  let client: ScoreboardClient
  let reader: ScoreboardClient
  let subscriber: ScoreboardClient
  let sink: ValkeyPlaylistSink
  const spaceGets: string[] = []
  const routers = new Map<string, Router>()
  const live = { id: 'vid_live', spaceSecret: SECRET }
  const programme = { id: 'vid_programme', spaceSecret: PROGRAMME_SECRET }

  before(async () => {
    await requireRedis()
    root = await mkdtemp(join(tmpdir(), 'tsMediaPlaylist-'))
    f = await groupFixture(undefined, undefined, (app, fixture) => {
      media = fixture.media
      media.mediaRoot = join(root, 'viewer')
      // Each mount is filled once the test has its clients.
      for (const mount of ['/api/v1/unfilled', '/api/v1/bare', '/api/v1'])
        app.use(mount, (req, res, next) => {
          const router = routers.get(mount)
          if (router == null) next()
          else router(req, res, next)
        })
    })
    store = await startFakeSpace({ space: f.h.space, dir: join(root, 'space') })
    f.h.space.endpoint = store.url
    store.server.on('request', req => {
      if (req.method === 'GET') spaceGets.push(req.url!.split('?')[0])
    })
    watched = await watchedDatabase(f.h.db)
    prefix = testPrefix()
    client = await connectedClient()
    reader = await connectedClient()
    subscriber = makeScoreboardSubscriber(reader, quiet)
    await subscriber.connect()
    sink = new ValkeyPlaylistSink(client, prefix)
    const livePlaylists = { client: reader, subscriber, prefix }
    feed = new PostgresFeed({ databaseUrl: watched.url, log: quiet })
    const filled = new FeedHolder()
    routers.set(
      '/api/v1',
      mediaRoutes(watched.db, { ...media, liveFeed: filled, livePlaylists })
    )
    filled.fill(feed)
    routers.set(
      '/api/v1/unfilled',
      mediaRoutes(watched.db, {
        ...media,
        liveFeed: new FeedHolder(),
        livePlaylists
      })
    )
    routers.set('/api/v1/bare', mediaRoutes(watched.db, media))
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_playlist',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        start_at: new Date()
      })
      .execute()
    for (const [video, kind] of [
      [live, 'live'],
      [programme, 'program']
    ] as const)
      await f.h.db
        .insertInto('videos')
        .values({
          id: video.id,
          title: 'Demo recording',
          game_id: 'gam_playlist',
          kind,
          status: 'ready',
          storage: 'spaces',
          space_secret: video.spaceSecret,
          spaces_verified_at: kind === 'live' ? null : new Date()
        })
        .execute()
    await put(
      programme,
      'master.m3u8',
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvideo.m3u8\n'
    )
    await put(
      programme,
      'video.m3u8',
      '#EXTM3U\n#EXT-X-MAP:URI="video.mp4",BYTERANGE="4@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:8@4\nvideo.mp4\n#EXT-X-ENDLIST\n'
    )
    // The notices reach the route: one of them is heard here too.
    const heard: string[] = []
    const probe = feed.subscribe('live_changes', {
      onPayload: payload => heard.push(payload ?? '')
    })
    await probe.listening
    // A notice goes out only when a watched column changes.
    await f.h.db
      .updateTable('videos')
      .set({ storage: 'local' })
      .where('id', '=', live.id)
      .execute()
    await f.h.db
      .updateTable('videos')
      .set({ storage: 'spaces' })
      .where('id', '=', live.id)
      .execute()
    await until('the notices', () => heard.length >= 2)
    probe.stop()
  })
  after(async () => {
    await feed?.close()
    await watched?.db.destroy()
    await quit(subscriber)
    await quit(reader)
    await quit(client)
    if (prefix != null) await dropPrefix(prefix)
    store?.server.close()
    await f?.h.close()
    await rm(root, { recursive: true, force: true })
  })
  beforeEach(() => {
    spaceGets.length = 0
  })

  async function put(
    video: { id: string; spaceSecret: string },
    file: string,
    body: string
  ): Promise<void> {
    const dir = join(root, 'space', videoPrefix(video))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), body)
  }
  const hls = async (
    id: string,
    file: string,
    mount = '',
    token = signQueryToken(media.mediaSecret, `hls:${id}`)
  ): Promise<Response> =>
    await f.h.request(
      'GET',
      `${mount}/videos/${id}/hls/${file}?t=${token}`,
      undefined,
      null
    )
  const liveIndexGets = (): number =>
    spaceGets.filter(path => path.endsWith(`${videoPrefix(live)}index.m3u8`))
      .length
  const setHidden = async (id: string, hidden: boolean): Promise<void> => {
    await f.h.db
      .updateTable('videos')
      .set({ hidden })
      .where('id', '=', id)
      .execute()
  }

  it('serves what rewriteMediaPlaylist makes of the Space body, byte for byte, without reading it', async () => {
    const dir = join(root, 'local')
    await mkdir(dir, { recursive: true })
    const publisher = new OriginPublisher({
      space: f.h.space,
      videoId: live.id,
      spaceSecret: SECRET,
      dir,
      ffmpegPath: 'ffmpeg',
      isFinal: () => true,
      onFirstSegment: async () => {},
      probe: async () => ({
        codecName: 'hevc',
        codecTag: 'hvc1',
        width: 1280,
        height: 720
      }),
      playlistSink: sink
    })
    let apiGets = 0
    const signer = new SpacePlayback({
      space: f.h.space,
      expiresSec: MEDIA_TOKEN_TTL_SEC
    })
    await writeFile(join(dir, 'init.mp4'), 'an init segment')
    for (let count = 1; count <= 4; count++) {
      await writeFile(join(dir, segment(count - 1)), `fragment ${count - 1}`)
      await writeFile(join(dir, 'master.m3u8'), playlist(count))
      // The uploader's own start reads the Space; only the API's reads count.
      apiGets += liveIndexGets()
      await publisher.flush()
      spaceGets.length = 0
      const spaceBody = await readFile(
        join(root, 'space', videoPrefix(live), 'index.m3u8'),
        'utf8'
      )
      const expected = rewriteMediaPlaylist(spaceBody, uri =>
        signer.sign(live, uri)
      )
      let body = ''
      await until(`piece ${count}`, async () => {
        const response = await hls(live.id, 'index.m3u8')
        expect(response.status).equals(200)
        expect(response.headers.get('cache-control')).equals(
          'private, max-age=1'
        )
        body = await response.text()
        return body === expected
      })
      expect(Buffer.from(body).equals(Buffer.from(expected))).equals(true)
    }
    expect(
      await client.lLen(livePlaylistKey(prefix, live.id)),
      'the first body and three additions'
    ).equals(4)
    apiGets += liveIndexGets()
    expect(apiGets, 'the API never read the live index').equals(0)
  })

  it('reads the row once for 100 requests, and again after its notice', async () => {
    await hls(live.id, 'index.m3u8')
    const before = rowReads(watched.statements)
    for (let n = 0; n < 100; n++)
      expect((await hls(live.id, 'index.m3u8')).status).equals(200)
    expect(rowReads(watched.statements) - before).equals(0)
    // A token that fails is refused before the cache is looked at.
    await setHidden(live.id, true)
    const refused = rowReads(watched.statements)
    expect((await hls(live.id, 'index.m3u8', '', 'bad.token')).status).equals(
      403
    )
    expect(rowReads(watched.statements)).equals(refused)
    await until(
      'the hidden live video refused',
      async () => (await hls(live.id, 'index.m3u8')).status === 404
    )
    await setHidden(live.id, false)
    await until(
      'the live video back',
      async () => (await hls(live.id, 'index.m3u8')).status === 200
    )
    // A programme video too.
    expect((await hls(programme.id, 'master.m3u8')).status).equals(200)
    const programmeReads = rowReads(watched.statements)
    expect((await hls(programme.id, 'video.m3u8')).status).equals(200)
    expect(rowReads(watched.statements)).equals(programmeReads)
    await setHidden(programme.id, true)
    await until(
      'the hidden programme refused',
      async () => (await hls(programme.id, 'master.m3u8')).status === 404
    )
    await setHidden(programme.id, false)
    await until(
      'the programme back',
      async () => (await hls(programme.id, 'master.m3u8')).status === 200
    )
  })

  it('reads the row per request, and the Space once a second, before the feed holder is filled', async () => {
    const before = rowReads(watched.statements)
    for (let n = 0; n < 5; n++) {
      const response = await hls(live.id, 'index.m3u8', '/unfilled')
      expect(response.status).equals(200)
      expect(await response.text()).contains(`${videoPrefix(live)}seg000003`)
    }
    expect(rowReads(watched.statements) - before).equals(5)
    expect(liveIndexGets()).equals(1)
    await new Promise(resolve => setTimeout(resolve, 1050))
    await hls(live.id, 'index.m3u8', '/unfilled')
    expect(liveIndexGets()).equals(2)
  })

  it('serves from the Space at most once a second with no feed and no Valkey', async () => {
    const before = rowReads(watched.statements)
    for (let n = 0; n < 5; n++)
      expect((await hls(live.id, 'index.m3u8', '/bare')).status).equals(200)
    expect(rowReads(watched.statements) - before).equals(5)
    expect(liveIndexGets()).equals(1)
    expect((await hls(programme.id, 'master.m3u8', '/bare')).status).equals(200)
  })
})

describe('the playlist route’s row cache', function () {
  this.timeout(30000)
  let f: GroupFixture
  let watched: Awaited<ReturnType<typeof watchedDatabase>>
  let handlers: FeedHandlers | undefined
  let time = 0
  const fakeFeed: ChangeFeed = {
    subscribe: (_channel, given) => {
      handlers = given
      return { listening: Promise.resolve(), stop: () => {} }
    },
    publishEphemeral: async () => {},
    close: async () => {}
  }
  before(async () => {
    f = await groupFixture()
    watched = await watchedDatabase(f.h.db)
    await f.h.db
      .insertInto('games')
      .values({
        id: 'gam_rows',
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        start_at: new Date()
      })
      .execute()
    await f.h.db
      .insertInto('videos')
      .values({
        id: 'vid_rows',
        title: 'Demo recording',
        game_id: 'gam_rows',
        kind: 'live',
        status: 'ready',
        storage: 'spaces'
      })
      .execute()
  })
  after(async () => {
    await watched?.db.destroy()
    await f?.h.close()
  })
  beforeEach(() => {
    handlers = undefined
    time = 0
  })
  const reads = (): number => rowReads(watched.statements)
  function cache(): ReturnType<typeof hlsRowCache> {
    const holder = new FeedHolder()
    const rows = hlsRowCache(watched.db, holder, () => time)
    holder.fill(fakeFeed)
    expect(() => {
      holder.fill(fakeFeed)
    }).throws('already filled')
    return rows
  }

  it('keeps nothing until the feed is listening, then keeps a row for 30 s', async () => {
    const rows = cache()
    const start = reads()
    await rows.get('vid_rows')
    await rows.get('vid_rows')
    expect(reads()).equals(start + 2)
    handlers!.onListening!(true)
    await rows.get('vid_rows')
    await rows.get('vid_rows')
    expect(reads()).equals(start + 3)
    time += HLS_ROW_TTL_MS - 1
    await rows.get('vid_rows')
    expect(reads()).equals(start + 3)
    time += 1
    expect((await rows.get('vid_rows'))?.storage).equals('spaces')
    expect(reads()).equals(start + 4)
  })

  it('forgets a row on its video’s notice, on a gap and on one it cannot read, but not on a game’s', async () => {
    const rows = cache()
    handlers!.onListening!(true)
    await rows.get('vid_rows')
    const start = reads()
    // json_build_object's spacing.
    handlers!.onPayload('{"g" : "gam_rows"}')
    handlers!.onPayload('{"s" : "lst_x", "v" : null}')
    handlers!.onPayload('{"v" : "vid_other"}')
    await rows.get('vid_rows')
    expect(reads()).equals(start)
    handlers!.onPayload('{"s" : "lst_x", "v" : "vid_rows"}')
    await rows.get('vid_rows')
    expect(reads()).equals(start + 1)
    handlers!.onPayload('{"v" : "vid_rows"}')
    await rows.get('vid_rows')
    expect(reads()).equals(start + 2)
    handlers!.onListening!(false)
    await rows.get('vid_rows')
    expect(reads()).equals(start + 3)
    handlers!.onPayload('not json')
    await rows.get('vid_rows')
    handlers!.onPayload(undefined)
    await rows.get('vid_rows')
    expect(reads()).equals(start + 5)
    await rows.get('vid_rows')
    expect(reads()).equals(start + 5)
  })

  it('does not keep a read a notice overtook, nor a row that is not there', async () => {
    const rows = cache()
    handlers!.onListening!(true)
    const start = reads()
    const reading = rows.get('vid_rows')
    handlers!.onPayload('{"v" : "vid_rows"}')
    await reading
    await rows.get('vid_rows')
    expect(reads()).equals(start + 2)
    await rows.get('vid_rows')
    expect(reads()).equals(start + 2)
    await rows.get('vid_nowhere')
    expect(await rows.get('vid_nowhere')).equals(undefined)
    expect(reads()).equals(start + 4)
  })

  it('drops the rows that expired, not only the one read again', async () => {
    await f.h.db
      .insertInto('videos')
      .values({
        id: 'vid_rows_b',
        title: 'Demo recording',
        game_id: 'gam_rows',
        kind: 'live',
        status: 'ready',
        storage: 'spaces'
      })
      .execute()
    try {
      const rows = cache()
      handlers!.onListening!(true)
      await rows.get('vid_rows')
      await rows.get('vid_rows_b')
      expect(rows.held()).equals(2)
      time += HLS_ROW_TTL_MS - 1
      await rows.get('vid_rows')
      expect(rows.held()).equals(2)
      time += 1
      // Only one is asked for again: the other goes all the same.
      await rows.get('vid_rows')
      expect(rows.held()).equals(1)
    } finally {
      await f.h.db.deleteFrom('videos').where('id', '=', 'vid_rows_b').execute()
    }
  })
})

describe('the ingest’s playlist sink', function () {
  this.timeout(90000)
  let f: Awaited<ReturnType<typeof originFixture>>
  let prefix: string
  let client: ScoreboardClient
  let watched: Awaited<ReturnType<typeof watchedDatabase>>
  let feed: PostgresFeed
  const ephemeral: string[] = []
  const logged: string[] = []
  before(async () => {
    await requireRedis()
  })
  beforeEach(async () => {
    f = await originFixture()
    prefix = testPrefix()
    client = await connectedClient()
    watched = await watchedDatabase(f.f.h.db)
    feed = new PostgresFeed({ databaseUrl: watched.url, log: quiet })
    const publishEphemeral = feed.publishEphemeral.bind(feed)
    feed.publishEphemeral = async (channel, payload, db) => {
      ephemeral.push(payload)
      await publishEphemeral(channel, payload, db)
    }
  })
  afterEach(async () => {
    // Its own connections first: the fixture drops the database.
    await feed?.close()
    await watched?.db.destroy()
    await f?.close()
    await quit(client)
    await dropPrefix(prefix)
  })

  it('sends no Postgres statement in postgres mode, and deletes the list once the close is verified', async () => {
    const options: LiveControllerOptions = {
      ...f.options,
      db: watched.db,
      feed,
      playlistClient: client,
      playlistPrefix: prefix,
      log: line => {
        logged.push(line)
      }
    }
    const key = livePlaylistKey(prefix, f.videoId)
    // Starting a stream bumps the sync clock, which notifies: not the sink.
    watched.refuse.on = false
    await f.stage(2)
    await beganPublishing(options, f.stream.id)
    // From here on only the uploader and its sink run.
    watched.refuse.on = true
    for (const seconds of [2, 4, 6]) {
      await f.stage(seconds)
      await drainPublishForTest(f.videoId)
      const entries = await client.lRange(key, 0, -1)
      expect(entries.join('')).equals(await f.body())
    }
    expect(await client.lLen(key)).greaterThan(1)
    expect(watched.notifies, 'pg_notify').deep.equals([])
    expect(ephemeral).deep.equals([])
    watched.refuse.on = false
    await finishStream(options, f.stream.id, 'Finished')
    await drainPublishForTest(f.videoId)
    expect((await f.row())?.spaces_verified_at, logged.join('\n')).not.equals(
      null
    )
    expect(await client.exists(key), 'the list, once verified').equals(0)
    expect(
      Number(await client.get(livePlaylistGenKey(prefix, f.videoId)))
    ).greaterThan(0)
  })
})
