import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { addPerson } from '../../test/scoreboardKit'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import type { LiveControllerOptions } from './controller'
import {
  handleLiveEventForTest,
  liveVideoDir,
  resolveKey,
  sync
} from './controller'
import { sealSecret } from './secrets'
import { configureIngest, liveKeys, resetForTest } from './splitter'

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

    await handleLiveEventForTest(
      { type: 'publishStarted', key: THIRD_KEY, liveStreamId: 'liv_2' },
      options
    )
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
    await handleLiveEventForTest(
      { type: 'publishStarted', key: THIRD_KEY, liveStreamId: 'liv_2' },
      options
    )

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
})
