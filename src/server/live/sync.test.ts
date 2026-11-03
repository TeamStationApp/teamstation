import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { addPerson } from '../../test/scoreboardKit'
import { listenScreenScopes } from '../../test/screenScopeNotices'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import type { LiveControllerOptions } from './controller'
import {
  finishStream,
  handleLiveEventForTest,
  liveVideoDir,
  resolveKey,
  settleLiveWork,
  sync
} from './controller'
import { sealSecret } from './secrets'
import {
  configureIngest,
  forcePublishForTest,
  liveKeys,
  type LiveSpec,
  resetForTest,
  setLive
} from './splitter'

/**
 * What the ingest is told, once a second.
 *
 * The keys it will accept are not held anywhere but in its own memory, and
 * this loop is the only thing that puts them there or takes them away. The
 * case that matters most is a **rotation**: somebody rotates a key because it
 * has got out, and a rotation that left the old key working until the game
 * ended would be no rotation at all.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_sync_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)
const SECRET = 's'.repeat(32)
const FIRST_KEY = 'ts_firstkeyfirstkeyfirst'
const SECOND_KEY = 'ts_secondkeysecondkeysec'
const THIRD_KEY = 'ts_thirdkeythirdkeythirdk'
const FOURTH_KEY = 'ts_fourthkeyfourthkeyfour'
const FIFTH_KEY = 'ts_fifthkeyfifthkeyfifthk'

describe('what the ingest is told', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let mediaRoot = ''
  let options: LiveControllerOptions | undefined

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    mediaRoot = await mkdtemp(join(tmpdir(), 'tsSync-'))

    // Configured, not started: nothing binds a port here, and `setLive` and
    // `clearLive` are what this is about.
    configureIngest({
      ffmpegPath: '/does/not/matter',
      bindHost: '127.0.0.1',
      port: 19_362,
      app: 'live',
      segmentSeconds: 4,
      log: () => undefined,
      onEvent: () => undefined
    })

    options = {
      db,
      live: {
        enabled: true,
        bindHost: '127.0.0.1',
        port: 19_362,
        app: 'live',
        segmentSeconds: 4,
        freeDiskFloorGb: 1
      },
      ffmpegPath: '/does/not/matter',
      mediaRoot,
      workDir: join(mediaRoot, 'work'),
      sessionSecret: SECRET,
      log: () => undefined,
      // A terabyte, said rather than measured. Read from the real disk, this
      // suite takes the developer's free space as an input: a machine that
      // filled up while an unrelated build was running failed four assertions
      // here, and the message named nothing that was actually wrong. The one
      // test that wants the refusal says so by raising the floor instead.
      freeBytes: async () => 1_000_000_000_000
    }

    const now = new Date()
    for (const [id, name] of [
      ['tem_home', 'Demo Home'],
      ['tem_away', 'Demo Away']
    ]) {
      await db
        .insertInto('teams')
        .values({ id, name, created_at: now, updated_at: now })
        .execute()
    }
    await db
      .insertInto('games')
      .values({
        id: 'gam_1',
        home_team_id: 'tem_home',
        away_team_id: 'tem_away',
        start_at: now,
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      .insertInto('videos')
      .values({
        id: 'vid_1',
        game_id: 'gam_1',
        kind: 'live',
        title: 'Demo Away at Demo Home',
        storage: 'local',
        status: 'processing',
        hidden: true,
        created_at: now,
        updated_at: now
      })
      .execute()
    // A key publishes video as somebody.
    const owner = await addPerson(db, 'owner')
    await db
      .updateTable('users')
      .set({ login_enabled: true })
      .where('id', '=', owner.userId)
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: 'rol_sync_owner',
        user_id: owner.userId,
        scope_type: 'team',
        scope_id: 'tem_home',
        role: 'videographer'
      })
      .execute()
    await db
      .insertInto('live_streams')
      .values({
        id: 'liv_1',
        game_id: 'gam_1',
        team_id: 'tem_home',
        user_id: owner.userId,
        key_hash: hashToken(FIRST_KEY),
        key_prefix: FIRST_KEY.slice(0, 8),
        key_cipher: sealSecret(SECRET, FIRST_KEY),
        state: 'idle',
        opens_at: new Date(now.getTime() - 3_600_000),
        closes_at: new Date(now.getTime() + 3_600_000),
        video_id: 'vid_1',
        created_at: now,
        updated_at: now
      })
      .execute()
  })

  after(async function () {
    resetForTest()
    if (db != null) await db.destroy()
    if (mediaRoot !== '') await rm(mediaRoot, { recursive: true, force: true })
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('hands the ingest the key of an open stream', async function () {
    if (options == null) this.skip()
    await sync(options)
    expect(liveKeys()).deep.equals([FIRST_KEY])
  })

  it('takes the old key away the moment one is rotated', async function () {
    if (options == null) this.skip()
    await db
      ?.updateTable('live_streams')
      .set({
        key_cipher: sealSecret(SECRET, SECOND_KEY),
        key_prefix: SECOND_KEY.slice(0, 8),
        key_hash: hashToken(SECOND_KEY),
        updated_at: new Date()
      })
      .where('id', '=', 'liv_1')
      .execute()

    await sync(options)
    // Both halves matter: the new key works, and the old one is gone. It used
    // to keep working, because the row's entry was overwritten with the new
    // key before anything looked at the old one.
    expect(liveKeys()).deep.equals([SECOND_KEY])
  })

  it('looks a key up for somebody who has only just been handed it', async function () {
    if (options == null) this.skip()
    const spec = await resolveKey(SECOND_KEY, options)
    expect(typeof spec).equals('object')
    expect((spec as { liveStreamId: string }).liveStreamId).equals('liv_1')
    expect(await resolveKey('ts_neverIssuedNeverIssued', options)).equals(
      undefined
    )
  })

  it('refuses that lookup too when there is no room to record', async function () {
    if (options == null) this.skip()
    // The door most first publishes come through: the loop's floor would have
    // refused this stream, and a key looked up on demand must not walk past it.
    const tight = {
      ...options,
      live: { ...options.live, freeDiskFloorGb: 1_000_000 }
    }
    const answer = await resolveKey(SECOND_KEY, tight)
    expect(typeof answer, 'a sentence, not a stream').equals('string')
    expect(typeof answer === 'string' ? answer : '').contains('not enough room')
  })

  it('leaves alone a key looked up after a running tick read the rows', async function () {
    if (options == null || db == null) this.skip()
    const lateKey = 'ts_latekeylatekeylatekeyl'
    const now = new Date()
    const first = await db
      .selectFrom('live_streams')
      .select('user_id')
      .where('id', '=', 'liv_1')
      .executeTakeFirstOrThrow()
    let reading = (): void => undefined
    const read = new Promise<void>(resolve => {
      reading = resolve
    })
    let release = (): void => undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const tick = sync({
      ...options,
      freeBytes: async () => {
        reading()
        await held
        return 1_000_000_000_000
      }
    })
    await read
    await db
      .insertInto('live_streams')
      .values({
        id: 'liv_late',
        game_id: 'gam_1',
        team_id: 'tem_home',
        user_id: first.user_id,
        slot: 2,
        key_hash: hashToken(lateKey),
        key_prefix: lateKey.slice(0, 8),
        key_cipher: sealSecret(SECRET, lateKey),
        state: 'idle',
        opens_at: now,
        video_id: 'vid_1',
        created_at: now,
        updated_at: now
      })
      .execute()
    const spec = await resolveKey(lateKey, options)
    expect(typeof spec).equals('object')
    setLive(lateKey, spec as LiveSpec)
    release()
    await tick
    expect(liveKeys(), 'the tick that could not see it').includes(lateKey)
    await sync(options)
    expect(liveKeys(), 'the tick that can').includes(lateKey)

    await db
      .updateTable('live_streams')
      .set({ state: 'revoked', closes_at: now, ended_at: now })
      .where('id', '=', 'liv_late')
      .execute()
    await sync(options)
    expect(liveKeys(), 'gone with the stream').not.includes(lateKey)
  })

  it('lets a key through days before the game, so it can be tried', async function () {
    if (options == null) this.skip()
    // The game is on Saturday and it is Thursday. This used to answer "not
    // open yet", which is how the first bench run of live streaming went: the
    // URL was right, the server was fine, and the operator was told no.
    const saturday = new Date(Date.now() + 2 * 86_400_000)
    await db
      ?.updateTable('live_streams')
      .set({
        opens_at: new Date(),
        closes_at: new Date(saturday.getTime() + 6 * 3_600_000),
        updated_at: new Date()
      })
      .where('id', '=', 'liv_1')
      .execute()

    const answer = await resolveKey(SECOND_KEY, options)
    expect(typeof answer, 'a stream, not a sentence').does.not.equal('string')

    await db
      ?.updateTable('live_streams')
      .set({
        opens_at: new Date(Date.now() - 3_600_000),
        closes_at: new Date(Date.now() + 3_600_000),
        updated_at: new Date()
      })
      .where('id', '=', 'liv_1')
      .execute()
  })

  it('says what became of a key whose stream has finished', async function () {
    if (options == null) this.skip()
    await db
      ?.updateTable('live_streams')
      .set({ state: 'ended', updated_at: new Date() })
      .where('id', '=', 'liv_1')
      .execute()

    const answer = await resolveKey(SECOND_KEY, options)
    expect(typeof answer === 'string' ? answer : '').contains(
      'already finished'
    )

    await db
      ?.updateTable('live_streams')
      .set({ state: 'idle', updated_at: new Date() })
      .where('id', '=', 'liv_1')
      .execute()
  })

  it('takes a key away when somebody ends it', async function () {
    if (options == null) this.skip()
    await db
      ?.updateTable('live_streams')
      .set({ closes_at: new Date(Date.now() - 1000), updated_at: new Date() })
      .where('id', '=', 'liv_1')
      .execute()

    await sync(options)
    expect(liveKeys()).deep.equals([])
    const row = await db
      ?.selectFrom('live_streams')
      .select(['state', 'last_error as lastError'])
      .where('id', '=', 'liv_1')
      .executeTakeFirst()
    expect(row?.state).equals('ended')
    expect(row?.lastError).equals('the stream was ended')
  })

  it('keeps one video through a reconnect that replaced a quiet publisher', async function () {
    if (options == null || db == null) this.skip()
    const now = new Date()
    await db
      .insertInto('videos')
      .values({
        id: 'vid_2',
        game_id: 'gam_1',
        kind: 'live',
        title: 'Home Plate',
        storage: 'local',
        status: 'processing',
        hidden: true,
        created_at: now,
        updated_at: now
      })
      .execute()
    const owner = await db
      .selectFrom('live_streams')
      .select('user_id as userId')
      .where('id', '=', 'liv_1')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('live_streams')
      .values({
        id: 'liv_2',
        game_id: 'gam_1',
        team_id: 'tem_home',
        user_id: owner.userId,
        key_hash: hashToken(THIRD_KEY),
        key_prefix: THIRD_KEY.slice(0, 8),
        key_cipher: sealSecret(SECRET, THIRD_KEY),
        state: 'idle',
        slot: 2,
        opens_at: new Date(now.getTime() - 3_600_000),
        video_id: 'vid_2',
        created_at: now,
        updated_at: now
      })
      .execute()
    const video = async (): Promise<{
      status: string
      hidden: boolean
      startAt: Date | null
    }> =>
      await db!
        .selectFrom('videos')
        .select(['status', 'hidden', 'start_at as startAt'])
        .where('id', '=', 'vid_2')
        .executeTakeFirstOrThrow()
    const stream = async (): Promise<{
      state: string
      videoId: string | null
    }> =>
      await db!
        .selectFrom('live_streams')
        .select(['state', 'video_id as videoId'])
        .where('id', '=', 'liv_2')
        .executeTakeFirstOrThrow()

    // Home and the game's event hear of each start and stop.
    const notices = await listenScreenScopes(db)
    let mark = notices.mark()
    await handleLiveEventForTest(
      { type: 'publishStarted', key: THIRD_KEY, liveStreamId: 'liv_2' },
      options
    )
    await notices.named(mark, { gameId: 'gam_1' })
    const first = await video()
    expect(first.status).equals('live')
    expect(first.startAt).not.equals(null)
    // The writer has been at it: the playlist is on the disk.
    const dir = liveVideoDir(mediaRoot, 'vid_2')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'master.m3u8'), '#EXTM3U\n')

    const gameVideos = async (): Promise<string[]> =>
      (
        await db!
          .selectFrom('videos')
          .select('id')
          .where('game_id', '=', 'gam_1')
          .execute()
      )
        .map(row => row.id)
        .sort()
    const videosBefore = await gameVideos()

    mark = notices.mark()
    // What the ingest says when a new publish replaces the quiet one: the old
    // connection's publish ended, and the new one's started.
    await handleLiveEventForTest(
      {
        type: 'publishEnded',
        key: THIRD_KEY,
        liveStreamId: 'liv_2',
        reason: 'The camera reconnected'
      },
      options
    )
    await notices.named(mark, { gameId: 'gam_1' })
    mark = notices.mark()
    await handleLiveEventForTest(
      { type: 'publishStarted', key: THIRD_KEY, liveStreamId: 'liv_2' },
      options
    )
    await notices.named(mark, { gameId: 'gam_1' })
    await notices.close()

    expect(await stream()).deep.equals({
      state: 'publishing',
      videoId: 'vid_2'
    })
    const after = await video()
    expect(after.status).equals('live')
    expect(after.hidden).equals(false)
    expect(after.startAt?.getTime()).equals(first.startAt?.getTime())
    // One video per stream: the reconnect made none of its own.
    expect(await gameVideos()).deep.equals(videosBefore)
  })

  describe('a publish refused for its codec', function () {
    const REFUSAL = 'TeamStation takes HEVC. This stream is H.264.'

    // Each camera has finished by the next, so the tests after these have
    // nothing of theirs to keep open.
    afterEach(async function () {
      const now = new Date()
      await db
        ?.updateTable('live_streams')
        .set({ state: 'ended', closes_at: now, ended_at: now })
        .where('slot', '=', 3)
        .execute()
    })

    const camera = async (id: string, key: string): Promise<string> => {
      const now = new Date()
      const videoId = `vid_${id}`
      await db!
        .insertInto('videos')
        .values({
          id: videoId,
          game_id: 'gam_1',
          kind: 'live',
          title: 'Backstop',
          storage: 'local',
          status: 'processing',
          hidden: true,
          created_at: now,
          updated_at: now
        })
        .execute()
      const owner = await db!
        .selectFrom('live_streams')
        .select('user_id as userId')
        .where('id', '=', 'liv_1')
        .executeTakeFirstOrThrow()
      await db!
        .insertInto('live_streams')
        .values({
          id,
          game_id: 'gam_1',
          team_id: 'tem_home',
          user_id: owner.userId,
          key_hash: hashToken(key),
          key_prefix: key.slice(0, 8),
          key_cipher: sealSecret(SECRET, key),
          state: 'idle',
          slot: 3,
          opens_at: new Date(now.getTime() - 3_600_000),
          video_id: videoId,
          created_at: now,
          updated_at: now
        })
        .execute()
      return videoId
    }

    /** The camera's real recording, from a publish before the refused one. */
    const written = async (videoId: string): Promise<string> => {
      const dir = liveVideoDir(mediaRoot, videoId)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'master.m3u8'), '#EXTM3U\n')
      await writeFile(join(dir, 'seg000000.m4s'), 'hevc')
      return dir
    }

    /** All the controller hears of a publish the ingest refuses. */
    const refused = async (id: string, key: string): Promise<void> => {
      await handleLiveEventForTest(
        { type: 'rejected', key, reason: REFUSAL },
        options!
      )
      await handleLiveEventForTest(
        {
          type: 'publishEnded',
          key,
          liveStreamId: id,
          reason: REFUSAL
        },
        options!
      )
    }

    const onDisk = async (dir: string): Promise<boolean> =>
      await readFile(join(dir, 'master.m3u8')).then(
        () => true,
        () => false
      )

    it('leaves a camera as it was made, with no sign of the attempt', async function () {
      if (options == null || db == null) this.skip()
      const key = 'ts_refusedkeyrefusedkeyre'
      const videoId = await camera('liv_refused', key)
      await refused('liv_refused', key)

      expect(
        await db
          .selectFrom('live_streams')
          .select([
            'state',
            'first_published_at as first',
            'last_published_at as last',
            'last_error as lastError'
          ])
          .where('id', '=', 'liv_refused')
          .executeTakeFirstOrThrow()
      ).deep.equals({
        state: 'idle',
        first: null,
        last: null,
        lastError: REFUSAL
      })
      expect(
        await db
          .selectFrom('videos')
          .select(['status', 'hidden', 'start_at as startAt'])
          .select('start_at_source as source')
          .where('id', '=', videoId)
          .executeTakeFirstOrThrow()
      ).deep.equals({
        status: 'processing',
        hidden: true,
        startAt: null,
        source: null
      })
    })

    it('keeps the first stamp and the recording of a camera that has published', async function () {
      if (options == null || db == null) this.skip()
      const key = 'ts_realkeyrealkeyrealkeyr'
      const videoId = await camera('liv_real', key)
      await handleLiveEventForTest(
        { type: 'publishStarted', key, liveStreamId: 'liv_real' },
        options
      )
      const dir = await written(videoId)
      await handleLiveEventForTest(
        {
          type: 'publishEnded',
          key,
          liveStreamId: 'liv_real',
          reason: 'The stream ended'
        },
        options
      )
      const stamped = async (): Promise<Date | null> =>
        (
          await db!
            .selectFrom('live_streams')
            .select('first_published_at as first')
            .where('id', '=', 'liv_real')
            .executeTakeFirstOrThrow()
        ).first
      const first = await stamped()
      expect(first).not.equals(null)
      const start = await db
        .selectFrom('videos')
        .select(['start_at as startAt'])
        .where('id', '=', videoId)
        .executeTakeFirstOrThrow()

      await new Promise(resolve => setTimeout(resolve, 5))
      await refused('liv_real', key)

      expect(await stamped()).deep.equals(first)
      const after = await db
        .selectFrom('live_streams')
        .innerJoin('videos', 'videos.id', 'live_streams.video_id')
        .select([
          'live_streams.state as state',
          'live_streams.last_error as lastError',
          'videos.status as status',
          'videos.hidden as hidden',
          'videos.start_at as startAt'
        ])
        .where('live_streams.id', '=', 'liv_real')
        .executeTakeFirstOrThrow()
      expect(after).deep.equals({
        state: 'idle',
        lastError: REFUSAL,
        status: 'live',
        hidden: false,
        startAt: start.startAt
      })
      expect(await onDisk(dir), 'the recording stays').equals(true)
    })

    it('clears a folder made again behind a camera removed with its key open', async function () {
      if (options == null || db == null) this.skip()
      const key = 'ts_gonekeygonekeygonekeyg'
      const videoId = await camera('liv_gone', key)
      const dir = await written(videoId)
      expect(await resolveKey(key, options)).to.be.an('object')
      await db.deleteFrom('videos').where('id', '=', videoId).execute()
      await db
        .updateTable('live_streams')
        .set({ state: 'revoked', closes_at: new Date() })
        .where('id', '=', 'liv_gone')
        .execute()

      await finishStream(options, 'liv_gone', 'revoked')
      await settleLiveWork()

      expect(await onDisk(dir), 'nothing is left behind').equals(false)
    })

    it('leaves the folder of a video that outlives its camera', async function () {
      if (options == null || db == null) this.skip()
      const key = 'ts_keptkeykeptkeykeptkeyk'
      const videoId = await camera('liv_kept', key)
      const dir = await written(videoId)
      expect(await resolveKey(key, options)).to.be.an('object')
      await db
        .updateTable('live_streams')
        .set({ state: 'revoked', closes_at: new Date(), video_id: null })
        .where('id', '=', 'liv_kept')
        .execute()

      await finishStream(options, 'liv_kept', 'revoked')
      await settleLiveWork()

      expect(await onDisk(dir), 'the video still has it').equals(true)
    })
  })

  it('finishes angles ended together side by side, not one after another', async function () {
    if (options == null || db == null) this.skip()
    // Both writers must receive their stop before either is allowed to exit.
    const writer = join(mediaRoot, 'slow-writer.sh')
    const ready = join(mediaRoot, 'writers-ready')
    const stopping = join(mediaRoot, 'writers-stopping')
    const completed = join(mediaRoot, 'writers-completed')
    const release = join(mediaRoot, 'release-writers')
    await writeFile(ready, '')
    await writeFile(stopping, '')
    await writeFile(completed, '')
    await writeFile(
      writer,
      `#!/bin/sh\ntrap 'kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; echo stopping >> "${stopping}"; while [ ! -f "${release}" ]; do sleep 0.01; done; echo completed >> "${completed}"; exit 0' TERM\nsleep 30 &\nchild=$!\necho ready >> '${ready}'\nwait\n`
    )
    const waitForBoth = async (path: string): Promise<number> => {
      const deadline = Date.now() + 5000
      let count = 0
      while (Date.now() < deadline) {
        count = (await readFile(path, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean).length
        if (count === 2) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      return count
    }
    await chmod(writer, 0o755)
    configureIngest({
      ffmpegPath: writer,
      bindHost: '127.0.0.1',
      port: 19_362,
      app: 'live',
      segmentSeconds: 4,
      log: () => undefined,
      onEvent: () => undefined
    })
    try {
      const now = new Date()
      const owner = await db
        .selectFrom('live_streams')
        .select('user_id as userId')
        .where('id', '=', 'liv_1')
        .executeTakeFirstOrThrow()
      const angles = [
        ['liv_3', 'vid_3', FOURTH_KEY, 3],
        ['liv_4', 'vid_4', FIFTH_KEY, 4]
      ] as const
      for (const [id, videoId, key, slot] of angles) {
        await db
          .insertInto('videos')
          .values({
            id: videoId,
            game_id: 'gam_1',
            kind: 'live',
            title: `Angle ${slot}`,
            storage: 'local',
            status: 'processing',
            hidden: true,
            created_at: now,
            updated_at: now
          })
          .execute()
        await db
          .insertInto('live_streams')
          .values({
            id,
            game_id: 'gam_1',
            team_id: 'tem_home',
            user_id: owner.userId,
            key_hash: hashToken(key),
            key_prefix: key.slice(0, 8),
            key_cipher: sealSecret(SECRET, key),
            state: 'idle',
            slot,
            opens_at: new Date(now.getTime() - 3_600_000),
            video_id: videoId,
            created_at: now,
            updated_at: now
          })
          .execute()
      }
      await sync(options)
      for (const [, , key] of angles) forcePublishForTest(key, true)
      expect(await waitForBoth(ready), 'both writers ready').equals(2)

      await db
        .updateTable('live_streams')
        .set({ closes_at: new Date(Date.now() - 1000) })
        .where('id', 'in', ['liv_3', 'liv_4'])
        .execute()
      const finished = sync(options)
      // Observe rejection immediately while checking the stop barrier.
      finished.catch(() => undefined)
      let stoppedTogether = 0
      try {
        stoppedTogether = await waitForBoth(stopping)
      } finally {
        await writeFile(release, '')
        await finished
      }
      expect(stoppedTogether, 'both stops precede either exit').equals(2)
      // A sequential stop can reach the second writer after force-killing
      // the first. Both must instead survive until the barrier is released.
      expect(
        (await readFile(completed, 'utf8')).trim().split('\n').filter(Boolean),
        'both writers finish gracefully after release'
      ).has.length(2)
      expect(liveKeys()).not.contains(FOURTH_KEY)
      expect(liveKeys()).not.contains(FIFTH_KEY)
      const ended = await db
        .selectFrom('live_streams')
        .select('state')
        .where('id', 'in', ['liv_3', 'liv_4'])
        .execute()
      expect(ended.map(row => row.state)).deep.equals(['ended', 'ended'])
    } finally {
      await writeFile(release, '')
      configureIngest({
        ffmpegPath: '/does/not/matter',
        bindHost: '127.0.0.1',
        port: 19_362,
        app: 'live',
        segmentSeconds: 4,
        log: () => undefined,
        onEvent: () => undefined
      })
    }
  })

  it('waits for every finish before a tick that fails part way, and loses none', async function () {
    if (options == null || db == null) this.skip()
    const now = new Date()
    const owner = await db
      .selectFrom('live_streams')
      .select('user_id as userId')
      .where('id', '=', 'liv_1')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('games')
      .values({
        id: 'gam_tick',
        home_team_id: 'tem_home',
        away_team_id: 'tem_away',
        start_at: now,
        created_at: now,
        updated_at: now
      })
      .execute()
    // liv_5 has been ended, and finishing it fails, as on a dropped database
    // connection. liv_6 comes after it, and its directory cannot be made.
    const streams = [
      ['liv_5', 'vid_5', 'ts_tickfivetickfivetickfi', 1, now],
      ['liv_6', 'vid_6', 'ts_ticksixticksixticksixt', 2, null]
    ] as const
    for (const [id, videoId, key, slot, closesAt] of streams) {
      await db
        .insertInto('videos')
        .values({
          id: videoId,
          game_id: 'gam_tick',
          kind: 'live',
          title: `Angle ${slot}`,
          storage: 'local',
          status: 'processing',
          hidden: true,
          created_at: now,
          updated_at: now
        })
        .execute()
      await db
        .insertInto('live_streams')
        .values({
          id,
          game_id: 'gam_tick',
          team_id: 'tem_home',
          user_id: owner.userId,
          key_hash: hashToken(key),
          key_prefix: key.slice(0, 8),
          key_cipher: sealSecret(SECRET, key),
          state: 'idle',
          slot,
          opens_at: new Date(now.getTime() - 3_600_000),
          closes_at: closesAt,
          video_id: videoId,
          created_at: now,
          updated_at: now
        })
        .execute()
    }
    const blocked = liveVideoDir(mediaRoot, 'vid_6')
    await mkdir(join(blocked, '..'), { recursive: true })
    await writeFile(blocked, 'not a directory')

    const real = db
    const failing = new Proxy(real, {
      get(target, property) {
        if (property === 'updateTable') {
          return (table: string) => {
            if (table === 'live_streams') throw new Error('connection lost')
            return target.updateTable(table as 'live_streams')
          }
        }
        const value = Reflect.get(target, property) as unknown
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value
      }
    })
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    try {
      let thrown: unknown
      await sync({ ...options, db: failing }).catch((error: unknown) => {
        thrown = error
      })
      for (let i = 0; i < 10; i++)
        await new Promise(resolve => setImmediate(resolve))
      // The tick says what stopped it, and the finish it had started was
      // waited for and caught rather than left to fail on its own.
      expect((thrown as NodeJS.ErrnoException | undefined)?.code).equals(
        'EEXIST'
      )
      expect(unhandled).deep.equals([])
    } finally {
      process.off('unhandledRejection', record)
      await rm(blocked, { force: true })
    }

    // With the database back, the next tick finishes it.
    await sync(options)
    const ended = await real
      .selectFrom('live_streams')
      .select('state')
      .where('id', '=', 'liv_5')
      .executeTakeFirstOrThrow()
    expect(ended.state).equals('ended')
  })
})
