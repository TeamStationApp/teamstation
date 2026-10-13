import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'
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
  liveVideoDir,
  RECONNECT_GRACE_MS,
  stopLiveController,
  sync
} from './controller'
import { sealSecret } from './secrets'
import {
  configureIngest,
  forcePublishForTest,
  LIVE_PLAYLIST_NAME,
  resetForTest
} from './splitter'

/**
 * When the people watching are told a stream has finished.
 *
 * Every player reads `EXT-X-ENDLIST` as the end of the broadcast and stops
 * for good, so it must not reach a live playlist while the publisher may yet
 * come back: a minute's grace from the moment it went, and never while the
 * ingest says it is publishing again. Past the grace it is written, once for
 * each time the publisher goes.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_grace_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)
const SECRET = 'g'.repeat(32)
const KEY = 'ts_gracekeygracekeygrace'
const OPEN = '#EXTM3U\n#EXTINF:4.000000,\nseg000000.m4s\n'

describe('the reconnect grace', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let mediaRoot = ''
  let options: LiveControllerOptions | undefined
  let playlist = ''

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
    mediaRoot = await mkdtemp(join(tmpdir(), 'tsGrace-'))
    playlist = join(liveVideoDir(mediaRoot, 'vid_grace'), LIVE_PLAYLIST_NAME)

    configureIngest({
      ffmpegPath: '/does/not/matter',
      bindHost: '127.0.0.1',
      port: 19_363,
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
        port: 19_363,
        app: 'live',
        segmentSeconds: 4,
        freeDiskFloorGb: 1
      },
      ffmpegPath: '/does/not/matter',
      mediaRoot,
      workDir: join(mediaRoot, 'work'),
      sessionSecret: SECRET,
      log: () => undefined,
      freeBytes: async () => 1_000_000_000_000
    }

    const now = new Date()
    for (const [id, name] of [
      ['tem_grace_home', 'Demo Home'],
      ['tem_grace_away', 'Demo Away']
    ]) {
      await db
        .insertInto('teams')
        .values({ id, name, created_at: now, updated_at: now })
        .execute()
    }
    await db
      .insertInto('games')
      .values({
        id: 'gam_grace',
        home_team_id: 'tem_grace_home',
        away_team_id: 'tem_grace_away',
        start_at: now,
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      .insertInto('videos')
      .values({
        id: 'vid_grace',
        game_id: 'gam_grace',
        kind: 'live',
        title: 'Home Plate',
        storage: 'local',
        status: 'live',
        hidden: false,
        created_at: now,
        updated_at: now
      })
      .execute()
    const owner = await addPerson(db, 'grace')
    await db
      .updateTable('users')
      .set({ login_enabled: true })
      .where('id', '=', owner.userId)
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: 'rol_grace_owner',
        user_id: owner.userId,
        scope_type: 'team',
        scope_id: 'tem_grace_home',
        role: 'videographer'
      })
      .execute()
    await db
      .insertInto('live_streams')
      .values({
        id: 'liv_grace',
        game_id: 'gam_grace',
        team_id: 'tem_grace_home',
        user_id: owner.userId,
        key_hash: hashToken(KEY),
        key_prefix: KEY.slice(0, 8),
        key_cipher: sealSecret(SECRET, KEY),
        state: 'idle',
        opens_at: new Date(now.getTime() - 3_600_000),
        video_id: 'vid_grace',
        first_published_at: new Date(now.getTime() - 600_000),
        created_at: now,
        updated_at: now
      })
      .execute()
  })

  beforeEach(async function () {
    if (options == null) return
    await mkdir(liveVideoDir(mediaRoot, 'vid_grace'), { recursive: true })
    await writeFile(playlist, OPEN)
  })

  after(async function () {
    stopLiveController()
    resetForTest()
    if (db != null) await db.destroy()
    if (mediaRoot !== '') await rm(mediaRoot, { recursive: true, force: true })
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  async function publisherLeft(
    agoMs: number,
    state: 'idle' | 'publishing' = 'idle'
  ): Promise<void> {
    await db
      ?.updateTable('live_streams')
      .set({ state, last_published_at: new Date(Date.now() - agoMs) })
      .where('id', '=', 'liv_grace')
      .execute()
  }

  it('keeps the playlist open while the publisher may come back', async function () {
    if (options == null) this.skip()
    await publisherLeft(RECONNECT_GRACE_MS - 20_000)
    await sync(options)
    expect(await readFile(playlist, 'utf8')).equals(OPEN)
  })

  it('closes it once the publisher has stayed away past the grace, once', async function () {
    if (options == null) this.skip()
    await publisherLeft(RECONNECT_GRACE_MS + 5_000)
    await sync(options)
    expect(await readFile(playlist, 'utf8')).equals(`${OPEN}#EXT-X-ENDLIST\n`)
    // The same absence is not looked at again: the publisher coming back
    // reopens the playlist, and nothing here closes it under the new writer.
    await writeFile(playlist, OPEN)
    await sync(options)
    expect(await readFile(playlist, 'utf8')).equals(OPEN)
  })

  it('closes it again when the publisher goes again', async function () {
    if (options == null) this.skip()
    await publisherLeft(0, 'publishing')
    await sync(options)
    expect(await readFile(playlist, 'utf8')).equals(OPEN)
    await publisherLeft(RECONNECT_GRACE_MS + 1_000)
    await sync(options)
    expect(await readFile(playlist, 'utf8')).contains('#EXT-X-ENDLIST')
  })

  it('leaves it open while the ingest has the publisher back, whatever the row says', async function () {
    if (options == null) this.skip()
    await publisherLeft(RECONNECT_GRACE_MS + 30_000)
    // The publisher reconnected a moment ago: the ingest knows, and the row
    // has not caught up.
    forcePublishForTest(KEY, true)
    await sync(options)
    expect(await readFile(playlist, 'utf8')).equals(OPEN)
    forcePublishForTest(KEY, false)
  })

  /** A sync that runs `duringRead` while the controller reads the playlist. */
  async function syncReadingWith(
    duringRead: () => Promise<void>
  ): Promise<void> {
    if (options == null) return
    // The module itself, which the controller reads through, rather than
    // the copy an `import *` makes of it.
    const stubbed = require('node:fs/promises') as {
      readFile: (...args: unknown[]) => Promise<unknown>
    }
    const realRead = stubbed.readFile
    stubbed.readFile = async (...args: unknown[]) => {
      const text = await realRead(...args)
      if (String(args[0]) === playlist) await duringRead()
      return text
    }
    try {
      await sync(options)
    } finally {
      stubbed.readFile = realRead
      forcePublishForTest(KEY, false)
    }
  }

  it('leaves it open for a publisher that comes back while it is being read', async function () {
    if (options == null) this.skip()
    await publisherLeft(RECONNECT_GRACE_MS + 40_000)
    // The publisher reconnects while the controller is reading the playlist:
    // the ingest has it back, and its writer has reopened a playlist that had
    // nothing to take off yet.
    await syncReadingWith(async () => {
      forcePublishForTest(KEY, true)
    })
    expect(await readFile(playlist, 'utf8')).equals(OPEN)
  })

  it('writes nothing over a playlist that went, or was closed, while it was read', async function () {
    if (options == null) this.skip()
    await publisherLeft(RECONNECT_GRACE_MS + 45_000)
    await syncReadingWith(async () => {
      await writeFile(playlist, `${OPEN}#EXT-X-ENDLIST\n`)
    })
    expect(await readFile(playlist, 'utf8')).equals(`${OPEN}#EXT-X-ENDLIST\n`)
    await writeFile(playlist, OPEN)
    await publisherLeft(RECONNECT_GRACE_MS + 50_000)
    await syncReadingWith(async () => {
      await rm(playlist)
    })
    expect(await readFile(playlist, 'utf8').catch(() => 'gone')).equals('gone')
  })
})
