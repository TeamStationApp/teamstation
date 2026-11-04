import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import { type LiveFixture, liveFixture } from '../../test/liveFixture'
import {
  canEncode,
  encodeFragmented,
  FFMPEG,
  writeLive
} from '../../test/wallClockFixtures'
import type { ChangeFeed, FeedHandlers } from '../changeFeed/feed'
import { PostgresFeed } from '../changeFeed/postgresFeed'
import type { Database } from '../db/database'
import { startFakeSpace } from '../dev/fakeSpace'
import type { SpaceSettings } from '../media/spacesHls'
import { asServerConfig, type LiveSettings } from '../serverConfig'
import {
  beganPublishing,
  drainLiveController,
  handleLiveEventForTest,
  type LiveControllerOptions,
  liveVideoDir,
  localTickForTest,
  RECONNECT_GRACE_MS,
  settleLiveWork,
  startLiveController,
  stopLiveController,
  wallScansForTest
} from './controller'
import { OriginPublisher } from './originPublisher'
import { revokeStreams } from './revokeStreams'
import { liveKeys, resetForTest, statusFor } from './splitter'

/**
 * The controller syncs on `live_changes` notices, its own deadlines, feed
 * gaps and a safety resync, and its local timer reads no stream's row.
 *
 * Time here is real and short. Where the plan's figures are seconds of a
 * quiet window, the case runs the local timer ten times faster (`tickMs`) and
 * says so: the counts are per tick and per resync, not per wall second.
 */
const SECRET = 's'.repeat(32)
const run = promisify(execFile)

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function until(
  check: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 8000
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Never saw ${what}`)
    await wait(5)
  }
  return Date.now()
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  await new Promise<void>(resolve =>
    probe.close(() => {
      resolve()
    })
  )
  if (address == null || typeof address !== 'object') throw new Error('no port')
  return address.port
}

/** A change feed the test speaks for: notices and gaps when it says. */
function testFeed(): {
  feed: ChangeFeed
  notify: (payload: string) => void
  gap: () => void
} {
  let handlers: FeedHandlers | undefined
  return {
    feed: {
      subscribe: (channel, next) => {
        expect(channel).equals('live_changes')
        handlers = next
        return {
          listening: Promise.resolve(),
          stop: () => {
            handlers = undefined
          }
        }
      },
      publishEphemeral: async () => undefined,
      close: async () => undefined
    },
    notify: payload => {
      handlers?.onPayload(payload)
    },
    gap: () => {
      handlers?.onListening?.(false)
    }
  }
}

describe('the live controller on the change feed', function () {
  this.timeout(60_000)
  let fixture: LiveFixture | undefined
  let db: Kysely<Database>
  let mediaRoot = ''
  let feed: ChangeFeed | undefined
  const queries: Array<{ sql: string; at: number }> = []
  const said: string[] = []

  before(async function () {
    fixture = await liveFixture('feedsync')
    if (fixture == null) this.skip()
    db = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: fixture.url })
      }),
      log: event => {
        if (event.level === 'query')
          queries.push({ sql: event.query.sql, at: Date.now() })
      }
    })
  })

  beforeEach(async function () {
    mediaRoot = await mkdtemp(join(tmpdir(), 'tsFeedSync-'))
    queries.length = 0
    said.length = 0
  })

  afterEach(async function () {
    stopLiveController()
    await drainLiveController()
    resetForTest()
    await feed?.close()
    feed = undefined
    // Every test starts with no open stream of an earlier one.
    await fixture?.db
      .updateTable('live_streams')
      .set({ state: 'ended', ended_at: new Date() })
      .where('ended_at', 'is', null)
      .execute()
    await rm(mediaRoot, { recursive: true, force: true })
  })

  after(async function () {
    await db?.destroy()
    await fixture?.drop()
  })

  /** The sync's own read: the only select of every stream's key. */
  const syncs = (): Array<{ sql: string; at: number }> =>
    queries.filter(query => query.sql.includes('"keyCipher"'))

  async function start(
    extra: Partial<LiveControllerOptions> = {},
    live: Partial<LiveSettings> = {}
  ): Promise<LiveControllerOptions> {
    const options: LiveControllerOptions = {
      db,
      live: {
        ...asServerConfig({}).live,
        bindHost: '127.0.0.1',
        port: await freePort(),
        segmentSeconds: 1,
        ...live
      },
      ffmpegPath: FFMPEG,
      mediaRoot,
      workDir: mediaRoot,
      sessionSecret: SECRET,
      log: line => said.push(line),
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      ...extra
    }
    expect(await startLiveController(options)).equals(true)
    // The start's own sync, settled, before anything is measured.
    await until(() => syncs().length > 0, 'the first sync')
    await wait(50)
    return options
  }

  async function postgresFeed(): Promise<ChangeFeed> {
    feed = new PostgresFeed({
      databaseUrl: fixture!.url,
      log: () => undefined
    })
    return feed
  }

  async function addStream(
    state: 'idle' | 'publishing' = 'idle'
  ): Promise<{ id: string; key: string; videoId: string; gameId: string }> {
    const live = asServerConfig({}).live
    const made = await fixture!.addStream(live, SECRET, state)
    const row = await fixture!.db
      .selectFrom('live_streams')
      .select('game_id')
      .where('id', '=', made.id)
      .executeTakeFirstOrThrow()
    return { ...made, gameId: row.game_id }
  }

  it('runs one sync within 150 ms of a notice, and one for a burst of them', async function () {
    const stream = await addStream()
    await start({ feed: await postgresFeed() })
    expect(liveKeys()).includes(stream.key)

    const before = syncs().length
    const at = Date.now()
    await fixture!.db
      .updateTable('live_streams')
      .set({ closes_at: new Date(Date.now() + 3_600_000) })
      .where('id', '=', stream.id)
      .execute()
    const synced = await until(
      () => syncs().length > before,
      'a sync after the notice'
    )
    expect(synced - at).lessThan(150)

    await wait(300)
    const test = testFeed()
    stopLiveController()
    await drainLiveController()
    await start({ feed: test.feed })
    const after = syncs().length
    const sent = Date.now()
    for (let n = 0; n < 5; n++) {
      test.notify(`{"s" : "${stream.id}", "v" : "${stream.videoId}"}`)
      await wait(15)
    }
    expect(Date.now() - sent).lessThan(100)
    await wait(400)
    expect(syncs().length - after).equals(1)
  })

  it('syncs on a video notice only for a video among its rows', async function () {
    const stream = await addStream()
    const test = testFeed()
    await start({ feed: test.feed })
    const before = syncs().length
    test.notify('{"v" : "vid_not_one_of_ours"}')
    await wait(300)
    expect(syncs().length).equals(before)
    test.notify(`{"v" : "${stream.videoId}"}`)
    await until(() => syncs().length > before, 'a sync for its video')
    const games = syncs().length
    test.notify(`{"g" : "${stream.gameId}"}`)
    await until(() => syncs().length > games, 'a sync for a game')
    const unread = syncs().length
    test.notify('not a notice')
    await until(
      () => syncs().length > unread,
      'a sync for a payload it cannot read'
    )
  })

  it('syncs at once on a gap in the feed', async function () {
    await addStream()
    const test = testFeed()
    await start({ feed: test.feed })
    const before = syncs().length
    const at = Date.now()
    test.gap()
    const synced = await until(
      () => syncs().length > before,
      'a sync after the gap'
    )
    expect(synced - at).lessThan(50)
  })

  it('syncs at the earliest deadline its rows give, not at the resync', async function () {
    const stream = await addStream()
    await fixture!.db
      .updateTable('live_streams')
      .set({ opens_at: new Date(Date.now() + 3000) })
      .where('id', '=', stream.id)
      .execute()
    const begun = Date.now()
    await start()
    const first = syncs().length
    const next = await until(
      () => syncs().length > first,
      'the deadline sync',
      6000
    )
    expect(next - begun).within(2900, 3600)
  })

  it('waits for the resync or a notice after a sync that failed past its deadline, not running again at once', async function () {
    const stream = await addStream()
    await fixture!.db
      .updateTable('live_streams')
      .set({ opens_at: new Date(Date.now() + 600) })
      .where('id', '=', stream.id)
      .execute()
    // The sync's read of every stream fails while `failing` is on, as it
    // does when the database is out of reach.
    const failing = { on: false }
    const failed = (): number =>
      said.filter(line => line.includes('injected sync failure')).length
    const test = testFeed()
    await start(
      {
        feed: test.feed,
        db: db.withPlugin({
          transformQuery: args => {
            if (failing.on && JSON.stringify(args.node).includes('key_cipher'))
              throw new Error('injected sync failure')
            return args.node
          },
          transformResult: async args => args.result
        })
      },
      { resyncMs: 60_000 }
    )
    failing.on = true
    await until(() => failed() > 0, 'the deadline sync failing', 4000)
    await wait(500)
    expect(failed()).equals(1)

    failing.on = false
    const before = syncs().length
    test.notify(`{"s" : "${stream.id}"}`)
    await until(() => syncs().length > before, 'a sync on the next notice')
  })

  it('closes the playlist when the reconnect grace runs out, on its own deadline', async function () {
    const stream = await addStream()
    await fixture!.db
      .updateTable('live_streams')
      .set({
        first_published_at: new Date(Date.now() - RECONNECT_GRACE_MS),
        last_published_at: new Date(Date.now() - RECONNECT_GRACE_MS + 1500)
      })
      .where('id', '=', stream.id)
      .execute()
    const dir = liveVideoDir(mediaRoot, stream.videoId)
    await mkdir(dir, { recursive: true })
    const playlist = join(dir, 'master.m3u8')
    await run('sh', [
      '-c',
      `printf '#EXTM3U\\n#EXT-X-TARGETDURATION:1\\n#EXTINF:1,\\nseg000000.m4s\\n' > '${playlist}'`
    ])
    const begun = Date.now()
    await start()
    expect(await readFile(playlist, 'utf8')).not.contains('#EXT-X-ENDLIST')
    const closed = await until(
      async () => (await readFile(playlist, 'utf8')).includes('#EXT-X-ENDLIST'),
      'the playlist closed',
      5000
    )
    expect(closed - begun).within(1200, 2500)
  })

  it('runs the safety resync every live.resyncMs', async function () {
    await addStream()
    await start({}, { resyncMs: 400 })
    const first = syncs().length
    await wait(1300)
    const times = syncs()
      .slice(first - 1)
      .map(query => query.at)
    expect(times.length).within(3, 5)
    for (let n = 1; n < times.length; n++)
      expect(times[n] - times[n - 1]).within(350, 600)
  })

  it('stops a revoked key and a retargeted game’s camera within 200 ms of the commit', async function () {
    const revoked = await addStream()
    const moved = await addStream()
    await start({ feed: await postgresFeed() })
    expect(liveKeys()).includes(revoked.key)
    expect(liveKeys()).includes(moved.key)

    const user = await fixture!.db
      .selectFrom('live_streams')
      .select('user_id')
      .where('id', '=', revoked.id)
      .executeTakeFirstOrThrow()
    let at = Date.now()
    await fixture!.db
      .updateTable('live_streams')
      .set({ state: 'revoked', closes_at: new Date() })
      .where('id', '=', revoked.id)
      .execute()
    let stopped = await until(
      () => !liveKeys().includes(revoked.key),
      'the revoked key let go'
    )
    expect(stopped - at).lessThan(200)
    expect(liveKeys()).includes(moved.key)

    await fixture!.db
      .insertInto('teams')
      .values({
        id: 'tem_elsewhere',
        name: 'Demo Elsewhere',
        created_at: new Date(),
        updated_at: new Date()
      })
      .onConflict(oc => oc.doNothing())
      .execute()
    at = Date.now()
    await fixture!.db
      .updateTable('games')
      .set({ home_team_id: 'tem_elsewhere' })
      .where('id', '=', moved.gameId)
      .execute()
    stopped = await until(
      () => !liveKeys().includes(moved.key),
      'the retargeted camera let go'
    )
    expect(stopped - at).lessThan(200)
    expect(await fixture!.stateOf(moved.id)).equals('revoked')
    await settleLiveWork()
    await revokeStreams(fixture!.db, [user.user_id], 'test over')
  })

  it('stops a camera whose role was taken away within live.resyncMs, with no row of its own changing', async function () {
    const stream = await addStream()
    await start({ feed: await postgresFeed() }, { resyncMs: 600 })
    expect(liveKeys()).includes(stream.key)
    const roles = await fixture!.db
      .selectFrom('scope_roles')
      .selectAll()
      .where('scope_id', '=', 'tem_home')
      .execute()
    try {
      const at = Date.now()
      await fixture!.db
        .deleteFrom('scope_roles')
        .where('scope_id', '=', 'tem_home')
        .execute()
      const stopped = await until(
        () => !liveKeys().includes(stream.key),
        'the camera let go'
      )
      expect(stopped - at).lessThan(600 + 200)
    } finally {
      await fixture!.db.insertInto('scope_roles').values(roles).execute()
    }
  })

  it('reads no stream row between resyncs while streams publish, and writes their reports in one statement every two ticks', async function () {
    const first = await addStream('publishing')
    const second = await addStream('publishing')
    // Ten times faster than in production: a tick of 100 ms, a resync of
    // 1 s, over a window of 3 s, which is the plan's 30 s window.
    const options = await start(
      { feed: await postgresFeed(), tickMs: 100 },
      { resyncMs: 1000 }
    )
    const report = async (key: string): Promise<void> => {
      const status = statusFor(key)!
      await handleLiveEventForTest(
        {
          type: 'status',
          key,
          status: {
            ...status,
            ingress: { ...status.ingress, publishing: true }
          }
        },
        options
      )
    }
    const reporting = { on: true }
    const reports = (async () => {
      while (reporting.on) {
        await report(first.key)
        await report(second.key)
        await wait(50)
      }
    })()
    await wait(500)
    const from = Date.now()
    await wait(3000)
    const to = Date.now()
    reporting.on = false
    await reports

    const window = queries.filter(query => query.at >= from && query.at < to)
    const reads = window.filter(query =>
      /\bfrom "(live_streams|videos)"|join "(live_streams|videos)"/.test(
        query.sql
      )
    )
    expect(reads.length).at.most(4)
    expect(reads.every(query => query.sql.includes('"keyCipher"'))).equals(true)
    const statuses = window.filter(query =>
      query.sql.startsWith('update live_streams set status = v.status')
    )
    expect(statuses.length).within(14, 16)
    for (const one of statuses) expect(one.sql.match(/::jsonb/g)).length(2)
    const written = await fixture!.db
      .selectFrom('live_streams')
      .select(['status_at', 'last_published_at'])
      .where('id', 'in', [first.id, second.id])
      .execute()
    for (const row of written) {
      expect(row.status_at!.getTime()).greaterThan(from)
      expect(row.last_published_at!.getTime()).greaterThan(from)
    }
  })

  /** A report from the ingest for `key`, saying whether video is arriving. */
  async function reportStatus(
    options: LiveControllerOptions,
    key: string,
    publishing: boolean
  ): Promise<void> {
    const status = statusFor(key)!
    await handleLiveEventForTest(
      {
        type: 'status',
        key,
        status: { ...status, ingress: { ...status.ingress, publishing } }
      },
      options
    )
  }

  const statusWrites = (): Array<{ sql: string; at: number }> =>
    queries.filter(query =>
      query.sql.startsWith('update live_streams set status = v.status')
    )

  it('writes the status reports when every tick outlasts its interval', async function () {
    const stream = await addStream()
    const dir = liveVideoDir(mediaRoot, stream.videoId)
    await mkdir(dir, { recursive: true })
    await run('sh', [
      '-c',
      `printf '#EXTM3U\\n' > '${join(dir, 'master.m3u8')}'`
    ])
    // Every tick's wall-clock scan reads the video's stored points, which
    // take one and a half ticks here and then fail, so the next tick scans
    // again: each tick that runs makes the next one skip.
    const slow = new Set<string>()
    const options = await start(
      {
        tickMs: 100,
        db: db.withPlugin({
          transformQuery: args => {
            if (JSON.stringify(args.node).includes('video_wall_anchors'))
              slow.add(args.queryId.queryId)
            return args.node
          },
          transformResult: async args => {
            if (!slow.delete(args.queryId.queryId)) return args.result
            await wait(150)
            throw new Error('slow wall clock')
          }
        })
      },
      { resyncMs: 60_000 }
    )
    await until(
      () => said.some(line => line.includes('slow wall clock')),
      'a slow tick'
    )
    const before = statusWrites().length
    const from = Date.now()
    // Reports keep arriving, as the splitter's do, so every due write has
    // one to make.
    const reporting = setInterval(() => {
      reportStatus(options, stream.key, true).catch(() => {})
    }, 50)
    try {
      await reportStatus(options, stream.key, true)
      await wait(1500)
    } finally {
      clearInterval(reporting)
    }
    // A write every two ticks' time, at the first tick that runs once it is
    // due: of the five or so ticks that ran, about every one.
    expect(statusWrites().length - before).at.least(4)
    const row = await fixture!.db
      .selectFrom('live_streams')
      .select(['status_at', 'last_published_at'])
      .where('id', '=', stream.id)
      .executeTakeFirstOrThrow()
    expect(row.status_at!.getTime()).at.least(from)
    expect(row.last_published_at!.getTime()).at.least(from)
  })

  it('keeps the reports a failed status write held, and writes them with the next', async function () {
    const stream = await addStream()
    const failing = { on: false }
    const options = await start(
      {
        tickMs: 60_000,
        db: db.withPlugin({
          transformQuery: args => {
            if (
              failing.on &&
              JSON.stringify(args.node).includes('set status = v.status')
            )
              throw new Error('status write failed')
            return args.node
          },
          transformResult: async args => args.result
        })
      },
      { resyncMs: 60_000 }
    )
    const published = Date.now()
    await reportStatus(options, stream.key, true)
    failing.on = true
    let threw: unknown
    await localTickForTest(options).catch((error: unknown) => {
      threw = error
    })
    expect(String(threw)).contains('status write failed')
    // Gone idle since: its report still carries when video last arrived.
    await reportStatus(options, stream.key, false)
    failing.on = false
    await localTickForTest(options)
    const row = await fixture!.db
      .selectFrom('live_streams')
      .select(['status', 'last_published_at'])
      .where('id', '=', stream.id)
      .executeTakeFirstOrThrow()
    expect(row.last_published_at!.getTime()).within(published - 5, Date.now())
    expect(
      (row.status as { ingress: { publishing: boolean } }).ingress.publishing
    ).equals(false)
    // Written, it is let go: the next write has nothing to say.
    const writes = statusWrites().length
    await localTickForTest(options)
    expect(statusWrites().length).equals(writes)
  })

  it('stops a deleted video’s origin, lets its upload in flight finish, then removes everything it put in the Space', async function () {
    const space: SpaceSettings = {
      endpoint: '',
      region: 'test',
      bucket: 'test',
      accessKeyId: 'example',
      secretAccessKey: 'example',
      pathStyle: true
    }
    const remote = join(mediaRoot, 'space')
    const store = await startFakeSpace({ space, dir: remote })
    space.endpoint = store.url
    const events: string[] = []
    store.server.on('request', (req, res) => {
      const name = decodeURIComponent(new URL(req.url!, store.url).pathname)
        .split('/')
        .at(-1)
      events.push(`${req.method} ${name} start`)
      res.on('finish', () => events.push(`${req.method} ${name} done`))
    })
    try {
      const stream = await addStream()
      const dir = liveVideoDir(mediaRoot, stream.videoId)
      await mkdir(dir, { recursive: true })
      await stageHls(dir, 3)
      store.faults.set({ method: 'PUT', key: /seg000001/, delayMs: 800 })
      const options = await start({ feed: await postgresFeed(), space })
      await beganPublishing(options, stream.id)
      await until(
        () => events.includes('PUT seg000001.m4s start'),
        'the slow upload'
      )
      const deletedAt = events.length
      await fixture!.db
        .deleteFrom('videos')
        .where('id', '=', stream.videoId)
        .execute()
      await until(
        () => events.some(one => one.startsWith('DELETE')),
        'the removal'
      )
      await settleLiveWork()
      const after = events.slice(deletedAt)
      const lastPut = after.lastIndexOf('PUT seg000001.m4s done')
      const firstDelete = after.findIndex(one => one.startsWith('DELETE'))
      expect(lastPut).greaterThan(-1)
      expect(lastPut).lessThan(firstDelete)
      expect(
        after.filter(one => one.startsWith('PUT') && one.endsWith('start'))
      ).deep.equals([])
      expect(
        await readdir(join(remote, 'videos', stream.videoId)).catch(() => [])
      ).deep.equals([])
      expect(await stat(dir).catch(() => undefined)).equals(undefined)
    } finally {
      store.server.close()
    }
  })

  it('stores a new segment’s wall clock within 1.5 s with no sync in between, with a Space and without, and scans nothing for an unchanged playlist', async function () {
    if (!(await canEncode('libx265'))) this.skip()
    const plain = join(mediaRoot, 'camera.mp4')
    await encodeFragmented(plain, { codec: 'hevc', seconds: 4 })
    const space: SpaceSettings = {
      endpoint: '',
      region: 'test',
      bucket: 'test',
      accessKeyId: 'example',
      secretAccessKey: 'example',
      pathStyle: true
    }
    const store = await startFakeSpace({ space, dir: join(mediaRoot, 'space') })
    space.endpoint = store.url
    try {
      for (const withSpace of [false, true]) {
        const stream = await addStream()
        const dir = liveVideoDir(mediaRoot, stream.videoId)
        await mkdir(dir, { recursive: true })
        await writeLive(plain, dir, { seconds: 2 })
        const options = await start(withSpace ? { space } : {}, {
          resyncMs: 60_000
        })
        if (withSpace) await beganPublishing(options, stream.id)
        const points = async (): Promise<number[]> =>
          (
            await fixture!.db
              .selectFrom('video_wall_anchors')
              .select('media_ms')
              .where('video_id', '=', stream.videoId)
              .orderBy('media_ms')
              .execute()
          ).map(row => row.media_ms)
        await until(
          async () => (await points()).length === 2,
          'the first points'
        )
        const synced = syncs().length
        await writeLive(plain, dir, { fromSec: 2, seconds: 1, startNumber: 2 })
        const written = Date.now()
        const stored = await until(
          async () => (await points()).includes(2000),
          'the new segment’s point'
        )
        expect(stored - written).lessThan(1500)
        expect(syncs().length).equals(synced)

        const scans = wallScansForTest()
        await wait(2500)
        expect(wallScansForTest()).equals(scans)
        stopLiveController()
        await drainLiveController()
      }
    } finally {
      store.server.close()
    }
  })
})

describe('a live origin publisher', function () {
  this.timeout(30_000)

  // Its options hold no database and no way to reach one: what it is told
  // about the video comes from the controller's sync.
  it('flushes, publishes and closes with nothing but the Space', async function () {
    let notified = 0
    const root = await mkdtemp(join(tmpdir(), 'tsOriginNoDb-'))
    const space: SpaceSettings = {
      endpoint: '',
      region: 'test',
      bucket: 'test',
      accessKeyId: 'example',
      secretAccessKey: 'example',
      pathStyle: true
    }
    const store = await startFakeSpace({ space, dir: join(root, 'space') })
    space.endpoint = store.url
    try {
      const dir = join(root, 'local')
      await mkdir(dir)
      await stageHls(dir, 2)
      const publisher = new OriginPublisher({
        space,
        videoId: 'vid_nodb',
        dir,
        ffmpegPath: FFMPEG,
        isFinal: () => true,
        onFirstSegment: async () => {
          notified++
        },
        probe: async () => ({ codecName: 'h264', codecTag: 'avc1' })
      })
      await publisher.flush()
      const playlist = join(dir, 'master.m3u8')
      await run('sh', ['-c', `printf '#EXT-X-ENDLIST\\n' >> '${playlist}'`])
      const closed = await publisher.flush({ close: true })
      expect(closed.complete).equals(true)
      expect(closed.body).contains('#EXT-X-ENDLIST')
      expect(notified).equals(1)
      expect(
        await readFile(
          join(root, 'space', 'videos', 'vid_nodb', 'index.m3u8'),
          'utf8'
        )
      ).equals(closed.body)
    } finally {
      store.server.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})

/** A live HLS directory of `seconds` one-second fMP4 segments, as the writer leaves it. */
async function stageHls(dir: string, seconds: number): Promise<void> {
  await run(FFMPEG, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=160x90:rate=10:duration=${seconds}`,
    '-c:v',
    'libx264',
    '-g',
    '10',
    '-f',
    'hls',
    '-hls_time',
    '1',
    '-hls_playlist_type',
    'event',
    '-hls_flags',
    'omit_endlist',
    '-hls_segment_type',
    'fmp4',
    '-hls_segment_filename',
    join(dir, 'seg%06d.m4s'),
    join(dir, 'master.m3u8')
  ])
}
