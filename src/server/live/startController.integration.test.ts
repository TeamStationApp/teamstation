import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, afterEach, before, describe, it } from 'mocha'

import { type LiveFixture, liveFixture } from '../../test/liveFixture'
import { asServerConfig, type LiveSettings } from '../serverConfig'
import { assignGameLogos } from '../sponsors/logos'
import {
  beganPublishing,
  drainLiveController,
  type LiveControllerOptions,
  liveTimersRunningForTest,
  liveVideoDir,
  queueLiveWorkForTest,
  startLiveController,
  stopLiveController
} from './controller'

/**
 * The controller's start: nothing in the database or on the disk is touched
 * until this process holds the RTMP port.
 */
const SECRET = 's'.repeat(32)

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

async function accepts(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = new Socket()
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      resolve(false)
    })
    socket.connect(port, '127.0.0.1')
  })
}

describe('starting the live controller', function () {
  this.timeout(60000)
  let fixture: LiveFixture | undefined
  let mediaRoot = ''
  let holder: Server | undefined
  const lines: string[] = []

  before(async function () {
    fixture = await liveFixture('startcontroller')
    if (fixture == null) this.skip()
    mediaRoot = await mkdtemp(join(tmpdir(), 'tsStartController-'))
  })

  afterEach(async function () {
    stopLiveController()
    // The start's first sync may still be reading: the pool closes after it.
    await drainLiveController()
    if (holder != null) {
      const closing = holder
      holder = undefined
      await new Promise<void>(resolve =>
        closing.close(() => {
          resolve()
        })
      )
    }
  })

  after(async function () {
    await fixture?.drop()
    if (mediaRoot !== '') await rm(mediaRoot, { recursive: true, force: true })
  })

  function settings(port: number): LiveSettings {
    return { ...asServerConfig({}).live, bindHost: '127.0.0.1', port }
  }

  async function start(
    live: LiveSettings,
    bindTimeoutMs = 5000
  ): Promise<boolean> {
    lines.length = 0
    return await startLiveController(
      {
        db: fixture!.db,
        live,
        ffmpegPath: '/does/not/matter',
        mediaRoot,
        workDir: mediaRoot,
        sessionSecret: SECRET,
        log: line => lines.push(line),
        freeBytes: async () => Number.MAX_SAFE_INTEGER
      },
      bindTimeoutMs
    )
  }

  it('drains work that the work it waits on queues', async function () {
    const done: string[] = []
    queueLiveWorkForTest('first', async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      done.push('first')
      queueLiveWorkForTest('finish:later', async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        done.push('later')
      })
    })
    await drainLiveController()
    expect(done).deep.equals(['first', 'later'])
  })

  it('touches nothing when somebody else holds the port', async function () {
    const port = await freePort()
    holder = createServer()
    await new Promise<void>(resolve =>
      holder!.listen(port, '127.0.0.1', resolve)
    )
    const live = settings(port)
    const stream = await fixture!.addStream(live, SECRET, 'publishing')
    // A local copy that is safely away and past its grace: what a sweep
    // deletes.
    await fixture!.db
      .updateTable('videos')
      .set({
        storage: 'spaces',
        spaces_verified_at: new Date(0),
        local_delete_after: new Date(0)
      })
      .where('id', '=', stream.videoId)
      .execute()
    const dir = liveVideoDir(mediaRoot, stream.videoId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'seg000000.m4s'), 'still here')
    const before = await fixture!.db
      .selectFrom('videos')
      .selectAll()
      .where('id', '=', stream.videoId)
      .executeTakeFirstOrThrow()

    expect(await start(live)).equals(false)
    expect(lines).includes(`live ingest did not bind 127.0.0.1:${port}`)
    expect(liveTimersRunningForTest()).equals(false)
    // Give a sweep that should not have started the time to have run.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await fixture!.stateOf(stream.id)).equals('publishing')
    expect(await readdir(dir)).deep.equals(['seg000000.m4s'])
    expect(
      await fixture!.db
        .selectFrom('videos')
        .selectAll()
        .where('id', '=', stream.videoId)
        .executeTakeFirstOrThrow()
    ).deep.equals(before)

    await fixture!.db
      .updateTable('live_streams')
      .set({ state: 'idle' })
      .where('id', '=', stream.id)
      .execute()
  })

  it('resets leftover publishing rows and starts its timers once it holds the port', async function () {
    const port = await freePort()
    const live = settings(port)
    const publishing = await fixture!.addStream(live, SECRET, 'publishing')
    const idle = await fixture!.addStream(live, SECRET, 'idle')
    // A publisher that connected the moment the port opened: its publish is
    // newer than the start, and the row is its own.
    const fresh = await fixture!.addStream(live, SECRET, 'publishing')
    await fixture!.db
      .updateTable('live_streams')
      .set({ last_published_at: new Date(Date.now() + 60_000) })
      .where('id', '=', fresh.id)
      .execute()
    // A leftover the API touched since — a rename, an end — is still a
    // leftover: its publish is older.
    const touched = await fixture!.addStream(live, SECRET, 'publishing')
    await fixture!.db
      .updateTable('live_streams')
      .set({
        last_published_at: new Date(Date.now() - 60_000),
        updated_at: new Date(Date.now() + 60_000)
      })
      .where('id', '=', touched.id)
      .execute()
    const updatedAt = async (id: string): Promise<Date> =>
      (
        await fixture!.db
          .selectFrom('live_streams')
          .select('updated_at')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).updated_at
    const idleBefore = await updatedAt(idle.id)
    const publishingBefore = await updatedAt(publishing.id)

    expect(await start(live)).equals(true)
    expect(liveTimersRunningForTest()).equals(true)
    expect(await accepts(port)).equals(true)
    expect(await fixture!.stateOf(publishing.id)).equals('idle')
    expect(await fixture!.stateOf(idle.id)).equals('idle')
    expect(await fixture!.stateOf(fresh.id)).equals('publishing')
    expect(await fixture!.stateOf(touched.id)).equals('idle')
    expect((await updatedAt(publishing.id)).getTime()).greaterThan(
      publishingBefore.getTime()
    )
    expect((await updatedAt(idle.id)).getTime()).equals(idleBefore.getTime())

    stopLiveController()
    expect(liveTimersRunningForTest()).equals(false)
    expect(await accepts(port)).equals(false)
  })

  describe('U16 the first publish gives the game its sponsor logo', function () {
    const leagueId = 'lea_publish_logo'
    const options = (
      extra: Partial<LiveControllerOptions> = {}
    ): LiveControllerOptions => ({
      db: fixture!.db,
      live: settings(0),
      ffmpegPath: '/does/not/matter',
      mediaRoot,
      workDir: mediaRoot,
      sessionSecret: SECRET,
      log: line => lines.push(line),
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      ...extra
    })

    before(async function () {
      const db = fixture!.db
      await db
        .insertInto('leagues')
        .values({ id: leagueId, name: 'American League' })
        .execute()
      await db
        .updateTable('teams')
        .set({ league_id: leagueId })
        .where('id', '=', 'tem_home')
        .execute()
      await db
        .insertInto('sponsor_media')
        .values({
          id: 'smd_publish_logo',
          league_id: leagueId,
          purpose: 'logo',
          object_key: `sponsors/${leagueId}/smd_publish_logo.png`,
          content_type: 'image/png',
          bytes: 100,
          sha256: '0'.repeat(64),
          width: 480,
          height: 120,
          created_by: null
        })
        .execute()
      await db
        .insertInto('sponsor_logos')
        .values({
          id: 'slg_publish_logo',
          league_id: leagueId,
          media_id: 'smd_publish_logo',
          name: 'Logo',
          allocation: 10,
          position: 1,
          accepted_at: new Date(Date.now() - 60_000)
        })
        .execute()
    })

    const gameOf = async (streamId: string): Promise<string> =>
      (
        await fixture!.db
          .selectFrom('live_streams')
          .select('game_id')
          .where('id', '=', streamId)
          .executeTakeFirstOrThrow()
      ).game_id

    it('asks with the video’s start once it is live, and a second publish keeps the one logo', async function () {
      lines.length = 0
      const stream = await fixture!.addStream(settings(0), SECRET)
      const gameId = await gameOf(stream.id)
      const asked: Array<{ gameId: string; startedAt: Date; status: string }> =
        []
      const watching = options({
        assignLogos: async (db, game, startedAt) => {
          const video = await db
            .selectFrom('videos')
            .select('status')
            .where('id', '=', stream.videoId)
            .executeTakeFirstOrThrow()
          asked.push({ gameId: game, startedAt, status: video.status })
          return await assignGameLogos(db, game, startedAt)
        }
      })
      await beganPublishing(watching, stream.id)
      await beganPublishing(watching, stream.id)
      const video = await fixture!.db
        .selectFrom('videos')
        .select('start_at')
        .where('id', '=', stream.videoId)
        .executeTakeFirstOrThrow()
      expect(asked.map(one => one.gameId)).deep.equals([gameId, gameId])
      for (const one of asked) {
        expect(one.status).equals('live')
        expect(one.startedAt.getTime()).equals(
          new Date(video.start_at!).getTime()
        )
      }
      expect(
        await fixture!.db
          .selectFrom('game_sponsor_logos')
          .select(['league_id', 'logo_id'])
          .where('game_id', '=', gameId)
          .execute()
      ).deep.equals([{ league_id: leagueId, logo_id: 'slg_publish_logo' }])
      // The default is the real assignment.
      const other = await fixture!.addStream(settings(0), SECRET)
      await beganPublishing(options(), other.id)
      expect(
        await fixture!.db
          .selectFrom('game_sponsor_logos')
          .select('logo_id')
          .where('game_id', '=', await gameOf(other.id))
          .execute()
      ).to.have.length(1)
    })

    it('goes live when giving the logo fails, and says so', async function () {
      lines.length = 0
      const stream = await fixture!.addStream(settings(0), SECRET)
      const gameId = await gameOf(stream.id)
      await beganPublishing(
        options({
          assignLogos: async () => {
            throw new Error('no logos today')
          }
        }),
        stream.id
      )
      expect(await fixture!.stateOf(stream.id)).equals('publishing')
      expect(lines).includes(
        `live: sponsor logos for game ${gameId}: Error: no logos today`
      )
      await fixture!.db
        .updateTable('live_streams')
        .set({ state: 'idle' })
        .where('id', '=', stream.id)
        .execute()
    })
  })
})
