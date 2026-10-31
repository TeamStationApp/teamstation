import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import type { Kysely, Transaction } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { hashToken } from '../auth/tokens'
import { lockKeys } from '../db/advisoryLocks'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import {
  beganPublishing,
  handleLiveEventForTest,
  liveVideoDir,
  resolveKey
} from '../live/controller'
import {
  placeByFrameWall,
  placeByPublisher,
  PUBLISHER_LAG_MAX_MS,
  PUBLISHER_LEAD_MAX_MS,
  requestDeviceStream
} from '../live/streamKeys'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import {
  localCopyWarningDescription,
  recordLocalCopyWarnings,
  recordRecordingReminder,
  reminderDescription
} from '../notifications/recordingReminders'
import { directorRoutes } from './director'
import {
  ANOTHER_ACCOUNTS_RECORDING,
  directorUploadRoutes,
  namedBy,
  replaceLiveRecording
} from './directorUploads'
import { liveRoutes } from './live'
import { notificationRoutes } from './notifications'

/**
 * Phones and TS Director asking for their streams by device, the legacy
 * claim beside them, a phone's recording replacing its own angle, and the
 * reminder to upload it.
 *
 * Through the real routers, sign-in middleware and database, as the stream
 * key tests are: every one of the three is a place a rule could be lost.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_phonestreams_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const OWNER = 'tok_owner_phone_0000000000000000'
const OWNER_AGAIN = 'tok_owner_again_0000000000000000'
const OTHER = 'tok_other_phone_0000000000000000'
const PARENT = 'tok_parent_phone_000000000000000'

const IPHONE = '00000000-0000-4000-8000-000000000001'
const PIXEL = '00000000-0000-4000-8000-000000000002'
const IPAD = '00000000-0000-4000-8000-000000000003'

const LIVE = {
  enabled: true,
  bindHost: '0.0.0.0',
  port: 1936,
  app: 'live',
  segmentSeconds: 4,
  freeDiskFloorGb: 10
}

/** No Space: what a discard deletes here is on this disk. */
const NO_SPACE = {
  bucket: '',
  region: '',
  endpoint: '',
  accessKeyId: '',
  secretAccessKey: ''
}

const owner = mintUserId(() => false)
const other = mintUserId(id => id === owner.userId)
const parent = mintUserId(id => id === owner.userId || id === other.userId)

/** The fields a stream made without a device has always answered with. */
const BROWSER_STREAM_FIELDS = [
  'id',
  'gameId',
  'userId',
  'ownerName',
  'slot',
  'label',
  'keyPrefix',
  'state',
  'opensAt',
  'closesAt',
  'videoId',
  'lastError',
  'status',
  'url'
]

type Body = Record<string, any>

describe('phones and Directors asking for their streams by device', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  let uploadsDir = ''
  let games = 0

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
    try {
      await migrateUp(pool, migrations)
    } finally {
      await pool.end()
    }
    db = makeDatabase(scratchUrl)
    await seed(db)
    uploadsDir = await mkdtemp(join(tmpdir(), 'tsPhoneStreams-'))

    const app = express()
    app.use(express.json())
    app.use(withActor(db))
    app.use(withAudit(db))
    const host = 'live.example.test'
    const sessionSecret = 'k'.repeat(32)
    const space = {
      bucket: 'test',
      region: 'sfo3',
      endpoint: 'https://space.example.test',
      accessKeyId: 'k',
      secretAccessKey: 's'
    }
    // None configured for the live routes: what a discard deletes is local.
    app.use(
      '/api/v1',
      liveRoutes(db, {
        live: LIVE,
        sessionSecret,
        host,
        space: NO_SPACE,
        mediaRoot: uploadsDir
      })
    )
    app.use(
      '/api/v1',
      directorRoutes(db, {
        live: LIVE,
        sessionSecret,
        host,
        deviceLabel: 'TS Director'
      })
    )
    app.use(
      '/api/v1',
      directorUploadRoutes(db, {
        uploadsDir,
        mediaRoot: uploadsDir,
        ffmpegPath: '/usr/bin/ffmpeg',
        space
      })
    )
    app.use('/api/v1', notificationRoutes(db))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    const listening = server
    if (listening != null)
      await new Promise(resolve => listening.close(resolve))
    if (uploadsDir !== '')
      await rm(uploadsDir, { recursive: true, force: true })
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  async function seed(db: Kysely<Database>): Promise<void> {
    const now = new Date()
    for (const [made, name] of [
      [owner, 'Mookie Betts'],
      [other, 'Freddie Freeman'],
      [parent, 'Max Muncy']
    ] as const) {
      await insertFixtureUsers(db, {
        id: userIdOfGumbo(made.userId),
        legacyId: made.legacyId,
        display_name: name,
        first_name: null,
        last_name: null,
        login_enabled: true,
        created_at: now,
        updated_at: now
      })
    }
    for (const [id, user, token] of [
      ['ses_owner', owner.userId, OWNER],
      ['ses_owner_again', owner.userId, OWNER_AGAIN],
      ['ses_other', other.userId, OTHER],
      ['ses_parent', parent.userId, PARENT]
    ] as const) {
      await db
        .insertInto('auth_sessions')
        .values({
          id,
          user_id: userIdOfGumbo(user),
          token_hash: hashToken(token),
          expires_at: new Date(now.getTime() + 3_600_000),
          created_at: now
        })
        .execute()
    }
    for (const [id, name] of [
      ['tem_home', 'Harbor Demo'],
      ['tem_away', 'Ridge Demo']
    ]) {
      await db
        .insertInto('teams')
        .values({ id, name, created_at: now, updated_at: now })
        .execute()
    }
    for (const [id, user, role] of [
      ['mem_owner', owner.userId, 'manager'],
      ['mem_other', other.userId, 'manager'],
      ['mem_parent', parent.userId, 'member']
    ] as const) {
      await db
        .insertInto('memberships')
        .values({ id, user_id: userIdOfGumbo(user), team_id: 'tem_home', role })
        .execute()
    }
  }

  /** A game of its own for each case, so no case reads another's cameras. */
  async function newGame(): Promise<string> {
    games += 1
    const id = `gam_phone${games}`
    const now = new Date()
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: 'tem_home',
        away_team_id: 'tem_away',
        start_at: now,
        created_at: now,
        updated_at: now
      })
      .execute()
    return id
  }

  async function call(
    method: string,
    path: string,
    token: string,
    body?: unknown
  ): Promise<{ status: number; body: Body; text: string }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: body == null ? undefined : JSON.stringify(body)
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Body),
      text
    }
  }

  const ask = async (
    gameId: string,
    body: Body,
    token = OWNER
  ): Promise<{ status: number; body: Body }> =>
    await call('POST', `/games/${gameId}/live-streams`, token, body)

  const phone = (
    label: string | undefined,
    deviceId = IPHONE,
    extra: Body = {}
  ): Body => ({
    ...(label == null ? {} : { label }),
    deviceId,
    deviceModel: deviceId === PIXEL ? 'Pixel 10' : 'iPhone 13 Pro',
    recordsLocally: true,
    ...extra
  })

  const end = async (gameId: string, streamId: string): Promise<void> => {
    const ended = await call(
      'POST',
      `/games/${gameId}/live-streams/${streamId}/end`,
      OWNER
    )
    expect(ended.status).equals(200)
  }

  const claim = async (
    gameId: string,
    cameraName?: string,
    token = OWNER
  ): Promise<{ status: number; body: Body }> =>
    await call(
      'POST',
      `/director/events/${gameId}/claim`,
      token,
      cameraName == null ? {} : { cameraName }
    )

  const stream = async (
    id: string
  ): Promise<{
    state: string
    slot: number
    label: string | null
    deviceId: string | null
    videoId: string | null
    closesAt: Date | null
    localRecording: string
    recordsLocally: boolean
    directorClaimed: boolean
  }> =>
    await db!
      .selectFrom('live_streams')
      .select([
        'state',
        'slot',
        'label',
        'device_id as deviceId',
        'video_id as videoId',
        'closes_at as closesAt',
        'local_recording as localRecording',
        'records_locally as recordsLocally',
        'director_claimed as directorClaimed'
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()

  const streamsOn = async (gameId: string): Promise<number> =>
    (
      await db!
        .selectFrom('live_streams')
        .select('id')
        .where('game_id', '=', gameId)
        .execute()
    ).length

  /** The device-less stream the legacy claim holds for the owner. */
  const claimedStream = async (gameId: string): Promise<string> =>
    (
      await db!
        .selectFrom('live_streams')
        .select('id')
        .where('game_id', '=', gameId)
        .where('user_id', '=', userIdOfGumbo(owner.userId))
        .where('device_id', 'is', null)
        .where('state', '<>', 'revoked')
        .orderBy('slot')
        .executeTakeFirstOrThrow()
    ).id

  describe('S1 the device path of POST live-streams', function () {
    it('creates a stream in the lowest free slot, and returns it again for the same device and name', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      expect(made.status).equals(201)
      expect(made.body.slot).equals(1)
      expect(made.body.label).equals('Home Plate')
      expect(made.body.deviceId).equals(IPHONE)
      expect(made.body.deviceModel).equals('iPhone 13 Pro')
      expect(made.body.localRecording).equals('none')
      expect(String(made.body.url)).matches(
        /^rtmp:\/\/live\.example\.test:1936\/live\/ts_/
      )
      expect((await stream(made.body.id)).recordsLocally).equals(true)

      const again = await ask(gameId, phone('home plate'))
      expect(again.status).equals(200)
      expect(again.body.id).equals(made.body.id)
      expect(again.body.url).equals(made.body.url)

      const second = await ask(gameId, phone('First Base', PIXEL))
      expect(second.status).equals(201)
      expect(second.body.slot).equals(2)
      expect(second.body.deviceModel).equals('Pixel 10')
    })

    it('adopts the stream an installed Director claimed under the same name', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const claimed = await claim(gameId, 'Center Field')
      expect(claimed.status).equals(200)
      const claimedId = await claimedStream(gameId)
      const before = await stream(claimedId)

      const adopted = await ask(gameId, {
        label: 'center field',
        deviceId: IPAD,
        deviceModel: 'iPad Pro'
      })
      expect(adopted.status).equals(200)
      expect(adopted.body.id).equals(claimedId)
      expect(adopted.body.url).equals(claimed.body.url)
      expect(adopted.body.videoId).equals(before.videoId)
      expect(adopted.body.deviceModel).equals('iPad Pro')
      const after = await stream(claimedId)
      expect(after.deviceId).equals(IPAD)
      expect(after.recordsLocally).equals(false)
    })

    it('leaves a claimed stream that is still publishing to the build that claimed it', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const claimed = await claim(gameId, 'Home Plate')
      expect(claimed.status).equals(200)
      const claimedId = await claimedStream(gameId)
      // An old Director build is on the air with it.
      await db
        .updateTable('live_streams')
        .set({ state: 'publishing' })
        .where('id', '=', claimedId)
        .execute()

      // A phone of the same account, under the same name, gets its own.
      const phoneStream = await ask(gameId, phone('Home Plate'))
      expect(phoneStream.status).equals(201)
      expect(phoneStream.body.id).not.equals(claimedId)
      expect(phoneStream.body.url).not.equals(claimed.body.url)
      const kept = await stream(claimedId)
      expect(kept.deviceId).equals(null)
      expect(kept.state).equals('publishing')
    })

    it('never adopts a stream made on the website for streaming software', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const web = await ask(gameId, { label: 'Left Field' })
      expect(web.status).equals(201)
      const device = await ask(gameId, phone('Left Field'))
      expect(device.status).equals(201)
      expect(device.body.id).not.equals(web.body.id)
      expect((await stream(web.body.id)).deviceId).equals(null)
    })

    it('makes a new stream and video for an ended or replaced one, in the slot it freed', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const first = await ask(gameId, phone('Home Plate'))
      await ask(gameId, phone('First Base', PIXEL))
      await end(gameId, first.body.id)

      const fresh = await ask(gameId, phone('Home Plate'))
      expect(fresh.status).equals(201)
      expect(fresh.body.id).not.equals(first.body.id)
      expect(fresh.body.slot).equals(1)
      expect(fresh.body.videoId).not.equals(first.body.videoId)
      expect(fresh.body.url).not.equals(first.body.url)
      // The ended row stays beside the new one, with its video.
      const old = await stream(first.body.id)
      expect(old.state).equals('idle')
      expect(old.closesAt).not.equals(null)
      expect(old.videoId).equals(first.body.videoId)

      // Replaced by an upload: ended, so its name and slot are free.
      await db
        .updateTable('live_streams')
        .set({
          state: 'ended',
          closes_at: new Date(),
          local_recording: 'uploaded'
        })
        .where('id', '=', fresh.body.id)
        .execute()
      const next = await ask(gameId, phone('Home Plate'))
      expect(next.status).equals(201)
      expect(next.body.id).not.equals(fresh.body.id)
      expect(next.body.slot).equals(1)
    })

    it('answers a request without a device exactly as before', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, { label: 'Backstop' })
      expect(made.status).equals(201)
      expect(Object.keys(made.body)).deep.equals(BROWSER_STREAM_FIELDS)
      const bare = await ask(gameId, {})
      expect(bare.status).equals(201)
      expect(bare.body.label).equals('Camera 2')
      expect(Object.keys(bare.body)).deep.equals(BROWSER_STREAM_FIELDS)
    })

    it('refuses a device model over 60 characters, and a blank device id', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const long = await ask(
        gameId,
        phone('Home Plate', IPHONE, {
          deviceModel: 'x'.repeat(61)
        })
      )
      expect(long.status).equals(400)
      expect(String(long.body.message)).contains('60 characters')
      const blank = await ask(gameId, phone('Home Plate', '  '))
      expect(blank.status).equals(400)
      expect(await streamsOn(gameId)).equals(0)
    })

    it('keeps a device model it already has when a request sends none', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const again = await ask(gameId, {
        label: 'Home Plate',
        deviceId: IPHONE
      })
      expect(again.status).equals(200)
      expect(again.body.deviceModel).equals('iPhone 13 Pro')
      const renamed = await ask(
        gameId,
        phone('Home Plate', IPHONE, {
          deviceModel: 'iPhone 13 Pro Max'
        })
      )
      expect(renamed.body.id).equals(made.body.id)
      expect(renamed.body.deviceModel).equals('iPhone 13 Pro Max')
    })
  })

  describe('S1b End stays in force', function () {
    it('refuses a redial of an ended stream, and creates nothing', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      await end(gameId, made.body.id)
      const redial = await ask(
        gameId,
        phone('Home Plate', IPHONE, { heldStreamId: made.body.id })
      )
      expect(redial.status).equals(410)
      expect(redial.body.code).equals('gone')
      expect(redial.body.message).equals(
        'This camera was ended. Start streaming again to go live'
      )
      expect(await streamsOn(gameId)).equals(1)
      expect((await stream(made.body.id)).state).not.equals('revoked')

      // An explicit start sends no held stream, and goes live again.
      const start = await ask(gameId, phone('Home Plate'))
      expect(start.status).equals(201)
      expect((await stream(made.body.id)).state).not.equals('revoked')
      expect(await streamsOn(gameId)).equals(2)
    })

    it('refuses a redial of a revoked stream', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      await db
        .updateTable('live_streams')
        .set({ state: 'revoked' })
        .where('id', '=', made.body.id)
        .execute()
      const redial = await ask(
        gameId,
        phone('Home Plate', IPHONE, { heldStreamId: made.body.id })
      )
      expect(redial.status).equals(410)
      expect(await streamsOn(gameId)).equals(1)
    })

    it('treats a stream the ingest finished as ended', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      await db
        .updateTable('live_streams')
        .set({ state: 'ended', ended_at: new Date() })
        .where('id', '=', made.body.id)
        .execute()
      const redial = await ask(
        gameId,
        phone('Home Plate', IPHONE, { heldStreamId: made.body.id })
      )
      expect(redial.status).equals(410)
      // An explicit start goes live again on a fresh stream, and the finished
      // one stays.
      const start = await ask(gameId, phone('Home Plate'))
      expect(start.status).equals(201)
      expect((await stream(made.body.id)).state).equals('ended')
    })

    it('returns a held stream that is still active', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const redial = await ask(
        gameId,
        phone('Home Plate', IPHONE, { heldStreamId: made.body.id })
      )
      expect(redial.status).equals(200)
      expect(redial.body.id).equals(made.body.id)
    })

    it('returns a held stream renamed since, whatever name the redial sends', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const renamed = await call(
        'PATCH',
        `/games/${gameId}/live-streams/${made.body.id}`,
        OWNER,
        { label: 'First Base' }
      )
      expect(renamed.status).equals(200)

      // An engine that has not heard of the rename redials with the old name.
      const stale = await ask(
        gameId,
        phone('Home Plate', IPHONE, { heldStreamId: made.body.id })
      )
      expect(stale.status).equals(200)
      expect(stale.body.id).equals(made.body.id)
      expect(stale.body.label).equals('First Base')
      // And one that has, with the new one.
      const fresh = await ask(
        gameId,
        phone('First Base', IPHONE, { heldStreamId: made.body.id })
      )
      expect(fresh.status).equals(200)
      expect(fresh.body.id).equals(made.body.id)
      expect(await streamsOn(gameId)).equals(1)
      expect((await stream(made.body.id)).label).equals('First Base')
    })
  })

  describe('S2 camera names and the slot cap', function () {
    it('refuses a name one of my other devices already streams under, on create and on rename', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      await ask(gameId, phone('Home Plate'))
      const clash = await ask(gameId, phone('home plate', PIXEL))
      expect(clash.status).equals(409)
      expect(clash.body.message).equals(
        'You already have a camera called home plate on this game'
      )
      const first = await ask(gameId, phone('First Base', PIXEL))
      const rename = await call(
        'PATCH',
        `/games/${gameId}/live-streams/${first.body.id}`,
        OWNER,
        { label: 'HOME PLATE' }
      )
      expect(rename.status).equals(409)
      expect((await stream(first.body.id)).label).equals('First Base')

      // Renaming to its own name in another case is not a clash.
      const own = await call(
        'PATCH',
        `/games/${gameId}/live-streams/${first.body.id}`,
        OWNER,
        { label: 'FIRST BASE' }
      )
      expect(own.status).equals(200)
      expect(own.body.label).equals('FIRST BASE')
    })

    it('lets another person, a stream without a device, and no name share a name', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      expect((await ask(gameId, phone('Home Plate'))).status).equals(201)
      expect(
        (await ask(gameId, phone('Home Plate', PIXEL), OTHER)).status
      ).equals(201)
      expect((await ask(gameId, { label: 'Home Plate' })).status).equals(201)
      const unnamed = await ask(gameId, phone(undefined, PIXEL))
      expect(unnamed.status).equals(201)
      expect(unnamed.body.label).equals(`Camera ${unnamed.body.slot}`)
      // The same device asking again with no name finds its unnamed stream.
      const again = await ask(gameId, phone(undefined, PIXEL))
      expect(again.status).equals(200)
      expect(again.body.id).equals(unnamed.body.id)
    })

    it('lets an ended or revoked stream’s name be used again', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const ended = await ask(gameId, phone('Home Plate'))
      await end(gameId, ended.body.id)
      expect((await ask(gameId, phone('Home Plate', PIXEL))).status).equals(201)
      const revoked = await ask(gameId, phone('Dugout', IPAD))
      await db
        .updateTable('live_streams')
        .set({ state: 'revoked' })
        .where('id', '=', revoked.body.id)
        .execute()
      expect((await ask(gameId, phone('Dugout'))).status).equals(201)
    })

    it('refuses a fifth camera with the cap’s own message', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      for (const label of ['One', 'Two', 'Three', 'Four']) {
        expect((await ask(gameId, phone(label))).status, label).equals(201)
      }
      const fifth = await ask(gameId, phone('Five'))
      expect(fifth.status).equals(400)
      expect(String(fifth.body.message)).contains('4 cameras')
    })
  })

  describe('S3 GET live-streams', function () {
    it('says every camera’s device model and recording, and my own devices', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      await ask(gameId, phone('Home Plate'))
      await ask(gameId, { label: 'Backstop' })
      await ask(gameId, phone('First Base', PIXEL), OTHER)

      const listed = await call('GET', `/games/${gameId}/live-streams`, OWNER)
      expect(listed.status).equals(200)
      const { mine, others } = listed.body as {
        mine: Body[]
        others: Body[]
      }
      expect(mine.map(item => [item.deviceModel, item.deviceId])).deep.equals([
        ['iPhone 13 Pro', IPHONE],
        [null, null]
      ])
      for (const item of [...mine, ...others]) {
        expect(item.localRecording).equals('none')
        expect(item).has.property('deviceModel')
      }
      expect(others[0].deviceModel).equals('Pixel 10')
      expect(others[0]).not.has.property('deviceId')
    })

    it('tells somebody who may not film nothing at all', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      expect(
        (await call('GET', `/games/${gameId}/live-streams`, PARENT)).status
      ).equals(404)
    })
  })

  describe('S4 PATCH localRecording', function () {
    const reminders = async (streamId: string): Promise<number> =>
      (
        await db!
          .selectFrom('notification_events')
          .select('id')
          .where('source_type', '=', 'recordingUpload')
          .where('source_id', '=', streamId)
          .execute()
      ).length

    it('records one reminder, however often it is said', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const path = `/games/${gameId}/live-streams/${made.body.id}`
      const first = await call('PATCH', path, OWNER, {
        localRecording: 'recorded'
      })
      expect(first.status).equals(200)
      expect(first.body.localRecording).equals('recorded')
      expect(await reminders(made.body.id)).equals(1)
      const again = await call('PATCH', path, OWNER, {
        localRecording: 'recorded'
      })
      expect(again.status).equals(200)
      expect(await reminders(made.body.id)).equals(1)
      // And asking the reminder table directly makes no second one either.
      expect(await recordRecordingReminder(db, made.body.id)).equals(false)
    })

    it('takes removed, which settles the reminder and reads as none', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const path = `/games/${gameId}/live-streams/${made.body.id}`
      await call('PATCH', path, OWNER, { localRecording: 'recorded' })
      const removed = await call('PATCH', path, OWNER, {
        localRecording: 'removed'
      })
      expect(removed.status).equals(200)
      expect(removed.body.localRecording).equals('none')
      expect((await stream(made.body.id)).localRecording).equals('removed')
      const reminder = await db
        .selectFrom('notification_receipts')
        .innerJoin(
          'notification_events',
          'notification_events.id',
          'notification_receipts.event_id'
        )
        .select('notification_receipts.dismissed_at as dismissedAt')
        .where('notification_events.source_id', '=', made.body.id)
        .where('notification_events.source_type', '=', 'recordingUpload')
        .executeTakeFirstOrThrow()
      expect(reminder.dismissedAt).not.equals(null)

      const listed = await call('GET', `/games/${gameId}/live-streams`, OWNER)
      expect(listed.body.mine[0].localRecording).equals('none')
      // An uploaded copy stays uploaded, whatever a phone goes on to say.
      await db
        .updateTable('live_streams')
        .set({ local_recording: 'uploaded' })
        .where('id', '=', made.body.id)
        .execute()
      expect(
        (await call('PATCH', path, OWNER, { localRecording: 'removed' })).status
      ).equals(200)
      expect((await stream(made.body.id)).localRecording).equals('uploaded')
    })

    it('marks a stream made without recordsLocally as keeping its recording', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      // Made by a build that did not send recordsLocally.
      const made = await ask(gameId, {
        label: 'Home Plate',
        deviceId: IPHONE,
        deviceModel: 'iPhone 13 Pro'
      })
      expect(made.status).equals(201)
      expect((await stream(made.body.id)).recordsLocally).equals(false)
      // The phone redials saying it does; the stream learns it.
      const redial = await ask(
        gameId,
        phone('Home Plate', IPHONE, { heldStreamId: made.body.id })
      )
      expect(redial.body.id).equals(made.body.id)
      expect((await stream(made.body.id)).recordsLocally).equals(true)
      // And a redial that does not say so leaves it.
      await ask(gameId, {
        label: 'Home Plate',
        deviceId: IPHONE,
        heldStreamId: made.body.id
      })
      expect((await stream(made.body.id)).recordsLocally).equals(true)

      // Saying it holds a recording marks it too, whatever made it.
      const other = await ask(gameId, {
        label: 'First Base',
        deviceId: PIXEL,
        deviceModel: 'Pixel 10'
      })
      expect((await stream(other.body.id)).recordsLocally).equals(false)
      const marked = await call(
        'PATCH',
        `/games/${gameId}/live-streams/${other.body.id}`,
        OWNER,
        { localRecording: 'recorded' }
      )
      expect(marked.status).equals(200)
      expect((await stream(other.body.id)).recordsLocally).equals(true)
    })

    it('will not touch somebody else’s stream', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const theirs = await ask(gameId, phone('Home Plate'), OTHER)
      const answer = await call(
        'PATCH',
        `/games/${gameId}/live-streams/${theirs.body.id}`,
        OWNER,
        { localRecording: 'recorded' }
      )
      expect(answer.status).equals(404)
      expect(await reminders(theirs.body.id)).equals(0)
    })

    it('refuses any other value, and a stream with no device', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const wrong = await call(
        'PATCH',
        `/games/${gameId}/live-streams/${made.body.id}`,
        OWNER,
        { localRecording: 'uploaded' }
      )
      expect(wrong.status).equals(400)
      const web = await ask(gameId, { label: 'Backstop' })
      const deviceless = await call(
        'PATCH',
        `/games/${gameId}/live-streams/${web.body.id}`,
        OWNER,
        { localRecording: 'recorded' }
      )
      expect(deviceless.status).equals(400)
      expect(await reminders(made.body.id)).equals(0)
    })
  })

  describe('S4b PATCH liveStartedAt places the live video', function () {
    const video = async (
      streamId: string
    ): Promise<{ startAt: Date | null; source: string | null }> => {
      const { videoId } = await stream(streamId)
      return await db!
        .selectFrom('videos')
        .select(['start_at as startAt', 'start_at_source as source'])
        .where('id', '=', videoId!)
        .executeTakeFirstOrThrow()
    }

    const ingest = (): Parameters<typeof beganPublishing>[0] => ({
      db: db!,
      live: LIVE,
      ffmpegPath: '/not-used',
      mediaRoot: uploadsDir,
      workDir: uploadsDir,
      sessionSecret: 'k'.repeat(32)
    })

    /** What the ingest does when the publish arrives, at `heard`. */
    const publish = async (streamId: string, heard: Date): Promise<void> => {
      await beganPublishing(ingest(), streamId)
      await db!
        .updateTable('live_streams')
        .set({ first_published_at: heard })
        .where('id', '=', streamId)
        .execute()
      await db!
        .updateTable('videos')
        .set({ start_at: heard })
        .where('id', '=', (await stream(streamId)).videoId!)
        .execute()
    }

    const report = async (
      gameId: string,
      streamId: string,
      at: string,
      token = OWNER
    ): Promise<{ status: number; body: Body }> =>
      await call('PATCH', `/games/${gameId}/live-streams/${streamId}`, token, {
        liveStartedAt: at
      })

    it('moves a video the server placed to its first picture, once', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const heard = new Date(Date.now() - 10_000)
      await publish(made.body.id, heard)
      expect((await video(made.body.id)).source).equals('liveSession')

      const captured = new Date(heard.getTime() - 1620)
      const placed = await report(gameId, made.body.id, captured.toISOString())
      expect(placed.status).equals(200)
      expect(await video(made.body.id)).deep.equals({
        startAt: captured,
        source: 'publisher'
      })

      // A reconnect's account, or a second one, never moves it again; nor
      // does the ingest hearing the stream again.
      const later = new Date(heard.getTime() - 500)
      expect(
        (await report(gameId, made.body.id, later.toISOString())).status
      ).equals(200)
      await beganPublishing(ingest(), made.body.id)
      expect(await video(made.body.id)).deep.equals({
        startAt: captured,
        source: 'publisher'
      })
    })

    it('holds a start given before the ingest says the publish began', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('First Base', PIXEL))
      const captured = new Date(Date.now() - 750)
      expect(
        (await report(gameId, made.body.id, captured.toISOString())).status
      ).equals(200)
      expect(await video(made.body.id)).deep.equals({
        startAt: captured,
        source: 'publisher'
      })
      await beganPublishing(ingest(), made.body.id)
      expect(await video(made.body.id)).deep.equals({
        startAt: captured,
        source: 'publisher'
      })
    })

    it('ignores an account of a later publish, or one implausibly early', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const heard = new Date(Date.now() - 600_000)
      await publish(made.body.id, heard)
      const resumed = new Date(heard.getTime() + PUBLISHER_LAG_MAX_MS + 1000)
      expect(
        (await report(gameId, made.body.id, resumed.toISOString())).status
      ).equals(200)
      const early = new Date(heard.getTime() - PUBLISHER_LEAD_MAX_MS - 1000)
      expect(
        (await report(gameId, made.body.id, early.toISOString())).status
      ).equals(200)
      expect(await video(made.body.id)).deep.equals({
        startAt: heard,
        source: 'liveSession'
      })
    })

    it('refuses what is not an instant, and somebody else’s stream', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      expect(
        (await report(gameId, made.body.id, 'half past nine')).status
      ).equals(400)
      const theirs = await ask(gameId, phone('Home Plate'), OTHER)
      expect(
        (await report(gameId, theirs.body.id, new Date().toISOString())).status
      ).equals(404)
      expect((await video(made.body.id)).source).equals(null)
      expect((await video(theirs.body.id)).source).equals(null)
    })

    it('places nothing for a stream with no video', async function () {
      if (db == null) this.skip()
      expect(await placeByPublisher(db, 'liv_missing', new Date())).equals(
        false
      )
    })

    it('lets the wall clock in the first picture place the video, over a reported start', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const heard = new Date(Date.now() - 10_000)
      await publish(made.body.id, heard)
      const reported = new Date(heard.getTime() - 1600)
      expect(
        (await report(gameId, made.body.id, reported.toISOString())).status
      ).equals(200)
      const inBand = new Date(heard.getTime() - 1450)
      await handleLiveEventForTest(
        {
          type: 'publisherPlaced',
          key: 'ts_unused',
          liveStreamId: made.body.id,
          startedAt: inBand
        },
        ingest()
      )
      expect(await video(made.body.id)).deep.equals({
        startAt: inBand,
        source: 'publisher'
      })
      // The PATCH an older server needed arrives afterwards and changes
      // nothing.
      expect(
        (await report(gameId, made.body.id, reported.toISOString())).status
      ).equals(200)
      expect((await video(made.body.id)).startAt).deep.equals(inBand)
    })

    it('leaves a start set by hand, and ignores reports too far from the publish', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const heard = new Date(Date.now() - 10_000)
      await publish(made.body.id, heard)
      const far = new Date(heard.getTime() - PUBLISHER_LEAD_MAX_MS - 1000)
      expect(await placeByFrameWall(db, made.body.id, far)).equals(false)
      const late = new Date(heard.getTime() + PUBLISHER_LAG_MAX_MS + 1000)
      expect(await placeByFrameWall(db, made.body.id, late)).equals(false)
      const { videoId } = await stream(made.body.id)
      await db
        .updateTable('videos')
        .set({ start_at_source: 'manual' })
        .where('id', '=', videoId!)
        .execute()
      expect(
        await placeByFrameWall(
          db,
          made.body.id,
          new Date(heard.getTime() - 900)
        )
      ).equals(false)
      expect(await video(made.body.id)).deep.equals({
        startAt: heard,
        source: 'manual'
      })
    })
  })

  describe('S5 the legacy claim route', function () {
    it('keeps one device-less stream, renaming it in place, across claims and sign-ins', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const first = await claim(gameId, 'Center Field')
      expect(first.status).equals(200)
      const id = await claimedStream(gameId)
      expect((await stream(id)).directorClaimed).equals(true)
      expect((await stream(id)).label).equals('Center Field')

      const again = await claim(gameId)
      expect(again.body.url).equals(first.body.url)
      const renamed = await claim(gameId, 'Center Field 2')
      expect(renamed.body.url).equals(first.body.url)
      expect((await stream(id)).label).equals('Center Field 2')
      const back = await claim(gameId, 'Center Field', OWNER_AGAIN)
      expect(back.body.url).equals(first.body.url)
      expect(await claimedStream(gameId)).equals(id)
      expect((await stream(id)).label).equals('Center Field')
    })

    it('never returns or renames a phone’s stream, and the stream route reads the claimed one', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const phoneStream = await ask(gameId, phone('Home Plate'))
      expect(phoneStream.body.slot).equals(1)

      const claimed = await claim(gameId, 'Center Field')
      expect(claimed.status).equals(200)
      expect(claimed.body.url).not.equals(phoneStream.body.url)
      const id = await claimedStream(gameId)
      expect((await stream(id)).slot).equals(2)
      expect((await stream(phoneStream.body.id)).label).equals('Home Plate')
      const kept = await claim(gameId, 'Center Field 2')
      expect(kept.body.url).equals(claimed.body.url)
      expect((await stream(phoneStream.body.id)).label).equals('Home Plate')

      await db
        .updateTable('live_streams')
        .set({ last_error: 'The claimed camera’s own trouble' })
        .where('id', '=', id)
        .execute()
      const status = await call(
        'GET',
        `/director/events/${gameId}/stream`,
        OWNER
      )
      expect(status.status).equals(200)
      expect(status.body.lastError).equals('The claimed camera’s own trouble')
    })

    it('marks a device-less stream made on the website as claimed when it returns it', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const web = await ask(gameId, { label: 'Right Field' })
      expect((await stream(web.body.id)).directorClaimed).equals(false)
      const claimed = await claim(gameId)
      expect(claimed.body.url).equals(web.body.url)
      expect((await stream(web.body.id)).directorClaimed).equals(true)
    })

    it('never hands an installed Director a website stream somebody has published on', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      // The coach's streaming software, on the air on its key from the website.
      const web = await ask(gameId, { label: 'Center Field' })
      await db
        .updateTable('live_streams')
        .set({ first_published_at: new Date() })
        .where('id', '=', web.body.id)
        .execute()

      const claimed = await claim(gameId, 'Center Field')
      expect(claimed.status).equals(200)
      expect(claimed.body.url).not.equals(web.body.url)
      const website = await stream(web.body.id)
      expect(website.directorClaimed).equals(false)
      expect(website.label).equals('Center Field')
      const again = await claim(gameId)
      expect(again.body.url).equals(claimed.body.url)

      // The stream route reads the Director's camera, not the coach's.
      await db
        .updateTable('live_streams')
        .set({ last_error: 'The coach’s own trouble' })
        .where('id', '=', web.body.id)
        .execute()
      const status = await call(
        'GET',
        `/director/events/${gameId}/stream`,
        OWNER
      )
      expect(status.body.lastError).equals(null)

      // Nor does a device with the website stream's name adopt it.
      await db
        .updateTable('live_streams')
        .set({ label: 'Backstop' })
        .where('id', '=', web.body.id)
        .execute()
      const asked = await ask(gameId, phone('Backstop'))
      expect(asked.status).equals(201)
      expect(asked.body.id).not.equals(web.body.id)
      expect((await stream(web.body.id)).deviceId).equals(null)
    })

    it('lets the new Director build adopt what an old build claimed', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const old = await claim(gameId, 'Center Field')
      const id = await claimedStream(gameId)
      const updated = await ask(gameId, {
        label: 'Center Field',
        deviceId: IPAD,
        deviceModel: 'iPad Pro'
      })
      expect(updated.status).equals(200)
      expect(updated.body.id).equals(id)
      expect(updated.body.url).equals(old.body.url)
      // Its device stream is no longer the claim's: a claim now makes another.
      const next = await claim(gameId)
      expect(next.body.url).not.equals(old.body.url)
    })

    it('lets an updated Director with no camera name adopt what its old build claimed', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      // An old build at its default name claims with none, and the claim
      // route calls the camera after the Director.
      const old = await claim(gameId)
      const id = await claimedStream(gameId)
      expect((await stream(id)).label).equals('TS Director')
      const updated = await ask(gameId, {
        label: '',
        deviceId: IPAD,
        deviceModel: 'iPad Pro'
      })
      expect(updated.status).equals(200)
      expect(updated.body.id).equals(id)
      expect(updated.body.url).equals(old.body.url)
      expect(updated.body.label).equals('Camera 1')
      const adopted = await stream(id)
      expect(adopted.deviceId).equals(IPAD)
      expect(adopted.label).equals(null)
      const title = await db
        .selectFrom('videos')
        .select('title')
        .where('id', '=', adopted.videoId)
        .executeTakeFirstOrThrow()
      expect(title.title).equals('Ridge Demo at Harbor Demo — Camera 1')
      // Asked again without the stream it holds, the same device and no name
      // find the same stream: no second angle for one Director.
      const again = await ask(gameId, {
        deviceId: IPAD,
        deviceModel: 'iPad Pro'
      })
      expect(again.status).equals(200)
      expect(again.body.id).equals(id)
      expect(await streamsOn(gameId)).equals(1)
    })

    it('refuses a claim when every slot is held by devices', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      for (const label of ['One', 'Two', 'Three', 'Four']) {
        await ask(gameId, phone(label))
      }
      const refused = await claim(gameId, 'Center Field')
      expect(refused.status).equals(400)
      expect(String(refused.body.message)).contains('4 cameras')
    })
  })

  describe('S6 uploads naming their stream', function () {
    const HOUR = 3600
    const at = (sec: number): Date =>
      new Date(Date.UTC(2026, 4, 2, 18, 0, 0) + sec * 1000)

    /** Gives a stream's live video a place in time, as the ingest would. */
    const aired = async (
      streamId: string,
      from: number,
      seconds: number
    ): Promise<string> => {
      const { videoId } = await stream(streamId)
      await db!
        .updateTable('videos')
        .set({
          hidden: false,
          status: 'ready',
          start_at: at(from),
          duration_sec: seconds
        })
        .where('id', '=', videoId!)
        .execute()
      return videoId!
    }

    const uploadVideo = async (
      gameId: string,
      from: number,
      seconds: number
    ): Promise<string> => {
      const id = makeId('video')
      await db!
        .insertInto('videos')
        .values({
          id,
          game_id: gameId,
          kind: 'program',
          title: 'What the app called it',
          storage: 'spaces',
          status: 'ready',
          start_at: at(from),
          duration_sec: seconds,
          created_at: new Date(),
          updated_at: new Date()
        })
        .execute()
      return id
    }

    const video = async (
      id: string
    ): Promise<{ hidden: boolean; title: string; replacedBy: string | null }> =>
      await db!
        .selectFrom('videos')
        .select(['hidden', 'title', 'replaced_by as replacedBy'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()

    const receipt = async (
      streamId: string
    ): Promise<{ dismissedAt: Date | null } | undefined> =>
      await db!
        .selectFrom('notification_receipts')
        .innerJoin(
          'notification_events',
          'notification_events.id',
          'notification_receipts.event_id'
        )
        .select('notification_receipts.dismissed_at as dismissedAt')
        .where('notification_events.source_id', '=', streamId)
        .executeTakeFirst()

    const recorded = async (
      gameId: string,
      streamId: string
    ): Promise<void> => {
      const marked = await call(
        'PATCH',
        `/games/${gameId}/live-streams/${streamId}`,
        OWNER,
        { localRecording: 'recorded' }
      )
      expect(marked.status).equals(200)
    }

    const open = async (
      gameId: string,
      extra: Body,
      token = OWNER
    ): Promise<{ status: number; body: Body }> =>
      await call('POST', '/director/uploads', token, {
        gameId,
        title: 'Home Plate recording',
        filename: 'home-plate.mp4',
        sizeBytes: 20,
        ...extra
      })

    const uploadRow = async (
      uploadId: string
    ): Promise<{ liveStreamId: string | null; wholeStream: boolean }> =>
      await db!
        .selectFrom('director_uploads')
        .select([
          'live_stream_id as liveStreamId',
          'whole_stream as wholeStream'
        ])
        .where('id', '=', uploadId)
        .executeTakeFirstOrThrow()

    it('never hides a phone angle for an unnamed upload, and still hides a Director’s', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const home = await ask(gameId, phone('Home Plate'))
      const first = await ask(gameId, phone('First Base', PIXEL))
      const web = await ask(gameId, { label: 'Backstop' })
      await claim(gameId, 'Center Field', OTHER)
      const director = (
        await db
          .selectFrom('live_streams')
          .select('id')
          .where('game_id', '=', gameId)
          .where('user_id', '=', userIdOfGumbo(other.userId))
          .executeTakeFirstOrThrow()
      ).id
      const homeVideo = await aired(home.body.id, 0, 2 * HOUR)
      const firstVideo = await aired(first.body.id, 0, 2 * HOUR)
      const webVideo = await aired(web.body.id, 0, 2 * HOUR)
      const directorVideo = await aired(director, 0, 2 * HOUR)
      const programme = await uploadVideo(gameId, -60, 2 * HOUR + 60)

      const hidden = await replaceLiveRecording(db, gameId, programme)
      expect([...hidden].sort()).deep.equals([webVideo, directorVideo].sort())
      expect((await video(homeVideo)).hidden).equals(false)
      expect((await video(firstVideo)).hidden).equals(false)
    })

    it('refuses a recording of somebody else’s stream, rather than opening it unnamed', async function () {
      if (db == null) this.skip()
      // One person's take, resumed on a shared phone after another signed in.
      // Opened unnamed, it went down the coverage rule as the second person's
      // upload and could hide their own live copies.
      const gameId = await newGame()
      const theirs = await ask(gameId, phone('Home Plate'), OTHER)
      const before = await db
        .selectFrom('director_uploads')
        .select(eb => eb.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow()
      const opened = await open(gameId, {
        liveStreamId: theirs.body.id,
        wholeStream: true
      })
      expect(opened.status).equals(403)
      expect(opened.body.message).equals(ANOTHER_ACCOUNTS_RECORDING)
      const after = await db
        .selectFrom('director_uploads')
        .select(eb => eb.fn.countAll<string>().as('count'))
        .executeTakeFirstOrThrow()
      expect(after.count).equals(before.count)
      // Its own account opens it as before.
      const own = await open(gameId, { liveStreamId: theirs.body.id }, OTHER)
      expect(own.status).equals(201)
    })

    it('ignores a liveStreamId it may not use, and the upload still opens', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const elsewhere = await newGame()
      const otherGame = await ask(elsewhere, phone('Home Plate'))
      const uploaded = await ask(gameId, phone('Dugout'))
      await db
        .updateTable('live_streams')
        .set({ local_recording: 'uploaded' })
        .where('id', '=', uploaded.body.id)
        .execute()
      const director = await ask(gameId, {
        label: 'Center Field',
        deviceId: IPAD,
        deviceModel: 'iPad Pro'
      })
      for (const named of [
        otherGame.body.id,
        uploaded.body.id,
        director.body.id,
        'liv_nothingAtAll'
      ]) {
        const opened = await open(gameId, {
          liveStreamId: named,
          wholeStream: true
        })
        expect(opened.status, named).equals(201)
        // This account's own stream stays on the upload, so that the upload
        // replaces nothing rather than going by the coverage rule.
        expect(await uploadRow(opened.body.uploadId), named).deep.equals({
          liveStreamId: named === 'liv_nothingAtAll' ? null : named,
          wholeStream: false
        })
      }
    })

    it('replaces nothing for a recording of its own stream that it may not replace', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      // A coach's streaming software, and another account's Director.
      const web = await ask(gameId, { label: 'Backstop' })
      await claim(gameId, 'Center Field', OTHER)
      const director = (
        await db
          .selectFrom('live_streams')
          .select('id')
          .where('game_id', '=', gameId)
          .where('user_id', '=', userIdOfGumbo(other.userId))
          .executeTakeFirstOrThrow()
      ).id
      const webVideo = await aired(web.body.id, 0, 2 * HOUR)
      const directorVideo = await aired(director, 0, 2 * HOUR)
      // This phone's take, uploaded once already and now sent again.
      const home = await ask(gameId, phone('Home Plate'))
      await aired(home.body.id, 0, 2 * HOUR)
      await db
        .updateTable('live_streams')
        .set({ local_recording: 'uploaded' })
        .where('id', '=', home.body.id)
        .execute()

      const opened = await open(gameId, {
        liveStreamId: home.body.id,
        wholeStream: true
      })
      expect(opened.status).equals(201)
      const row = await db
        .selectFrom('director_uploads')
        .select(['live_stream_id', 'whole_stream'])
        .where('id', '=', opened.body.uploadId)
        .executeTakeFirstOrThrow()
      const upload = await uploadVideo(gameId, -60, 2 * HOUR + 60)
      // What the finish does with the row.
      expect(
        await replaceLiveRecording(db, gameId, upload, namedBy(row))
      ).deep.equals([])
      expect((await video(webVideo)).hidden).equals(false)
      expect((await video(directorVideo)).hidden).equals(false)
    })

    it('keeps a named stream, and refuses one that is still publishing', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const home = await ask(gameId, phone('Home Plate'))
      const opened = await open(gameId, {
        liveStreamId: home.body.id,
        wholeStream: true
      })
      expect(opened.status).equals(201)
      expect(await uploadRow(opened.body.uploadId)).deep.equals({
        liveStreamId: home.body.id,
        wholeStream: true
      })

      await db
        .updateTable('live_streams')
        .set({ state: 'publishing' })
        .where('id', '=', home.body.id)
        .execute()
      const live = await open(gameId, { liveStreamId: home.body.id })
      expect(live.status).equals(409)
      expect(live.body.message).equals(
        'Stop streaming this angle before uploading its recording'
      )
    })

    it('settles the copy warning with the reminder when the upload lands', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const home = await ask(gameId, phone('Home Plate'))
      await aired(home.body.id, 0, 600)
      await recorded(gameId, home.body.id)
      await end(gameId, home.body.id)
      await db
        .updateTable('live_streams')
        .set({ ended_at: new Date(Date.now() - 27.5 * 24 * 60 * 60 * 1000) })
        .where('id', '=', home.body.id)
        .execute()
      await recordLocalCopyWarnings(db)
      const waiting = async (): Promise<string[]> =>
        ((await call('GET', '/me/notifications', OWNER)).body.items as Body[])
          .filter(item => item.liveStreamId === home.body.id)
          .map(item => String(item.type))
          .sort()
      expect(await waiting()).deep.equals([
        'localCopyExpiring',
        'recordingUpload'
      ])
      const upload = await uploadVideo(gameId, 0, 600)
      await replaceLiveRecording(db, gameId, upload, {
        liveStreamId: home.body.id,
        wholeStream: true
      })
      expect((await stream(home.body.id)).localRecording).equals('uploaded')
      expect(await waiting()).deep.equals([])
    })

    it('replaces an ended angle that a new take has since followed, and clears its reminder', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const take1 = await ask(gameId, phone('Home Plate'))
      const liveVideo = await aired(take1.body.id, 0, 600)
      await recorded(gameId, take1.body.id)
      await end(gameId, take1.body.id)
      const take2 = await ask(gameId, phone('Home Plate'))
      expect(take2.status).equals(201)
      expect((await stream(take1.body.id)).closesAt).not.equals(null)

      const opened = await open(gameId, {
        liveStreamId: take1.body.id,
        wholeStream: true
      })
      expect((await uploadRow(opened.body.uploadId)).liveStreamId).equals(
        take1.body.id
      )
      const upload = await uploadVideo(gameId, 0, 600)
      const hidden = await replaceLiveRecording(db, gameId, upload, {
        liveStreamId: take1.body.id,
        wholeStream: true
      })
      expect(hidden).deep.equals([liveVideo])
      expect((await receipt(take1.body.id))?.dismissedAt).not.equals(null)
      expect((await stream(take2.body.id)).state).equals('idle')
    })

    it('replaces nothing while the named stream is publishing at the finish', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const home = await ask(gameId, phone('Home Plate'))
      const liveVideo = await aired(home.body.id, 0, 600)
      await recorded(gameId, home.body.id)
      await db
        .updateTable('live_streams')
        .set({ state: 'publishing' })
        .where('id', '=', home.body.id)
        .execute()
      const upload = await uploadVideo(gameId, 0, 600)
      expect(
        await replaceLiveRecording(db, gameId, upload, {
          liveStreamId: home.body.id,
          wholeStream: true
        })
      ).deep.equals([])
      expect((await video(liveVideo)).hidden).equals(false)
      expect((await video(upload)).title).equals('What the app called it')
      expect(await receipt(home.body.id)).equals(undefined)
      expect((await stream(home.body.id)).localRecording).equals('recorded')
    })

    it('replaces nothing when the phone dials the stream again just before the change', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const home = await ask(gameId, phone('Home Plate'))
      const liveVideo = await aired(home.body.id, 0, 600)
      await recorded(gameId, home.body.id)
      const upload = await uploadVideo(gameId, 0, 600)
      // Idle when the upload's finish reads it, publishing by the time the
      // change is made.
      const real = db
      const redialled = new Proxy(real, {
        get(target, property) {
          if (property === 'transaction') {
            return () => ({
              execute: async <T>(
                run: (trx: Transaction<Database>) => Promise<T>
              ): Promise<T> => {
                await target
                  .updateTable('live_streams')
                  .set({ state: 'publishing' })
                  .where('id', '=', home.body.id)
                  .execute()
                return await target.transaction().execute(run)
              }
            })
          }
          const value = Reflect.get(target, property) as unknown
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value
        }
      })
      expect(
        await replaceLiveRecording(redialled, gameId, upload, {
          liveStreamId: home.body.id,
          wholeStream: true
        })
      ).deep.equals([])
      const after = await stream(home.body.id)
      expect(after.state).equals('publishing')
      expect(after.localRecording).equals('recorded')
      expect((await video(liveVideo)).hidden).equals(false)
      expect((await video(liveVideo)).replacedBy).equals(null)
      expect((await video(upload)).title).equals('What the app called it')
      expect(await receipt(home.body.id)).equals(undefined)
    })

    it('hides exactly the whole stream’s video, whatever the coverage test says', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const home = await ask(gameId, phone('Home Plate'))
      const first = await ask(gameId, phone('First Base', PIXEL))
      const homeVideo = await aired(home.body.id, 0, 2 * HOUR)
      const firstVideo = await aired(first.body.id, 0, 2 * HOUR)
      await recorded(gameId, home.body.id)
      await recorded(gameId, first.body.id)
      // The owner opened one reminder and not the other.
      const opened = await db
        .selectFrom('notification_events')
        .select('id')
        .where('source_id', '=', first.body.id)
        .executeTakeFirstOrThrow()
      await call('PUT', `/me/notifications/${opened.id}/viewed`, OWNER, {})

      // A recording that ends an hour early fails the coverage test.
      const homeUpload = await uploadVideo(gameId, 0, HOUR)
      expect(
        await replaceLiveRecording(db, gameId, homeUpload, {
          liveStreamId: home.body.id,
          wholeStream: true
        })
      ).deep.equals([homeVideo])
      const replaced = await video(homeVideo)
      expect(replaced.hidden).equals(true)
      expect(replaced.replacedBy).equals(homeUpload)
      expect((await video(homeUpload)).title).equals(replaced.title)
      expect(replaced.title).contains('Home Plate')
      const after = await stream(home.body.id)
      expect(after.state).equals('ended')
      expect(after.localRecording).equals('uploaded')
      expect((await receipt(home.body.id))?.dismissedAt).not.equals(null)
      expect((await video(firstVideo)).hidden).equals(false)

      const firstUpload = await uploadVideo(gameId, 0, HOUR)
      expect(
        await replaceLiveRecording(db, gameId, firstUpload, {
          liveStreamId: first.body.id,
          wholeStream: true
        })
      ).deep.equals([firstVideo])
      expect((await receipt(first.body.id))?.dismissedAt).not.equals(null)

      // Asked again, an uploaded stream replaces nothing more.
      expect(
        await replaceLiveRecording(db, gameId, firstUpload, {
          liveStreamId: first.body.id,
          wholeStream: true
        })
      ).deep.equals([])
    })

    it('adds a partial recording as its own video without wholeStream', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const home = await ask(gameId, phone('Home Plate'))
      const homeVideo = await aired(home.body.id, 0, 2 * HOUR)
      await recorded(gameId, home.body.id)
      const partial = await uploadVideo(gameId, 0, HOUR)
      expect(
        await replaceLiveRecording(db, gameId, partial, {
          liveStreamId: home.body.id,
          wholeStream: false
        })
      ).deep.equals([])
      expect((await video(homeVideo)).hidden).equals(false)
      expect(await receipt(home.body.id)).equals(undefined)

      // One that covers it replaces it without wholeStream too.
      const whole = await uploadVideo(gameId, 0, 2 * HOUR)
      expect(
        await replaceLiveRecording(db, gameId, whole, {
          liveStreamId: home.body.id,
          wholeStream: false
        })
      ).deep.equals([homeVideo])
    })

    it('settles a stream that never reached the server when its recording lands', async function () {
      if (db == null) this.skip()
      for (const wholeStream of [true, false]) {
        const gameId = await newGame()
        // Its phone recorded, but its stream never connected: the ended
        // stream's placeholder video went, and the stream names none.
        const home = await ask(gameId, phone('Home Plate'))
        await recorded(gameId, home.body.id)
        await end(gameId, home.body.id)
        await db
          .updateTable('live_streams')
          .set({ video_id: null })
          .where('id', '=', home.body.id)
          .execute()
        const upload = await uploadVideo(gameId, 0, 600)
        expect(
          await replaceLiveRecording(db, gameId, upload, {
            liveStreamId: home.body.id,
            wholeStream
          })
        ).deep.equals([])
        const after = await stream(home.body.id)
        expect(after.localRecording, String(wholeStream)).equals('uploaded')
        expect(after.state).equals('ended')
        expect((await receipt(home.body.id))?.dismissedAt).not.equals(null)
        expect((await video(upload)).hidden).equals(false)
      }
    })

    it('settles nothing for a stream with no video that keeps no recording, or is on the air', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const director = await ask(gameId, {
        label: 'Center Field',
        deviceId: IPAD,
        deviceModel: 'iPad Pro'
      })
      const home = await ask(gameId, phone('Home Plate'))
      await db
        .updateTable('live_streams')
        .set({ video_id: null })
        .where('id', 'in', [director.body.id, home.body.id])
        .execute()
      await db
        .updateTable('live_streams')
        .set({ state: 'publishing' })
        .where('id', '=', home.body.id)
        .execute()
      const upload = await uploadVideo(gameId, 0, 600)
      for (const id of [director.body.id, home.body.id]) {
        expect(
          await replaceLiveRecording(db, gameId, upload, {
            liveStreamId: id,
            wholeStream: true
          })
        ).deep.equals([])
        expect((await stream(id)).localRecording).equals('none')
      }
    })

    it('replaces nothing for a named stream with no video or an unknown upload', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const home = await ask(gameId, phone('Home Plate'))
      expect(
        await replaceLiveRecording(db, gameId, 'vid_notThere', {
          liveStreamId: home.body.id,
          wholeStream: true
        })
      ).deep.equals([])
      await db
        .updateTable('live_streams')
        .set({ video_id: null })
        .where('id', '=', home.body.id)
        .execute()
      expect(
        await replaceLiveRecording(db, gameId, 'vid_notThere', {
          liveStreamId: home.body.id,
          wholeStream: true
        })
      ).deep.equals([])
    })
  })

  describe('S7 the reminder in the inbox', function () {
    it('waits in Pending, first, until it is dismissed, and then lives in History', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      // Somebody added the stream's owner to a team before the game: older news.
      const grantId = makeId('audit')
      await db
        .insertInto('notification_events')
        .values({
          id: grantId,
          source_type: 'grant',
          source_id: grantId,
          revision: 1,
          actor_id: userIdOfGumbo(owner.userId),
          metadata: { title: 'Mookie Betts added you to Harbor Demo' },
          recorded_recipients: [userIdOfGumbo(other.userId)],
          created_at: new Date(Date.now() - 3_600_000)
        })
        .execute()
      const home = await ask(gameId, phone('Home Plate'), OTHER)
      await call(
        'PATCH',
        `/games/${gameId}/live-streams/${home.body.id}`,
        OTHER,
        {
          localRecording: 'recorded'
        }
      )

      const pending = await call('GET', '/me/notifications', OTHER)
      expect(pending.status).equals(200)
      // The reminder alone waits in Pending; the grant is History.
      expect((pending.body.items as Body[]).map(item => item.type)).deep.equals(
        ['recordingUpload']
      )
      const [reminder] = pending.body.items as Body[]
      const grant = (
        (await call('GET', '/me/notifications?history=1', OTHER)).body
          .items as Body[]
      ).find(item => item.id === grantId)!
      expect(reminder.type).equals('recordingUpload')
      expect(reminder.title).equals('Upload your recording')
      expect(reminder.description).equals(
        'Home Plate on iPhone 13 Pro — provide a higher-quality copy for future viewing.'
      )
      expect(reminder.status).equals('pending')
      expect(reminder.canAct).equals(true)
      expect(reminder.viewed).equals(false)
      expect(reminder.gameId).equals(gameId)
      expect(reminder.liveStreamId).equals(home.body.id)
      expect(grant.type).equals('grant')
      expect(grant).not.has.property('gameId')
      expect(pending.body.hasPending).equals(true)
      expect(
        (await call('GET', '/me/notifications/summary', OTHER)).body.hasPending
      ).equals(true)

      // A page of one holds the reminder, and there is no next page.
      const page = await call('GET', '/me/notifications?limit=1', OTHER)
      expect((page.body.items as Body[]).map(item => item.id)).deep.equals([
        reminder.id
      ])
      expect(page.body.nextCursor).equals(null)

      const detail = await call(
        'GET',
        `/me/notifications/${reminder.id}`,
        OTHER
      )
      expect(detail.body.liveStreamId).equals(home.body.id)

      // Not something anybody else sends, or may dismiss.
      expect(
        (await call('GET', '/me/notifications?sent=1', OTHER)).body.items
      ).deep.equals([])
      expect(
        (
          await call(
            'PUT',
            `/me/notifications/${reminder.id}/dismissed`,
            OWNER,
            {}
          )
        ).status
      ).equals(404)

      const dismissed = await call(
        'PUT',
        `/me/notifications/${reminder.id}/dismissed`,
        OTHER,
        {}
      )
      expect(dismissed.status).equals(204)
      const stored = await db
        .selectFrom('notification_receipts')
        .select(['viewed_at as viewedAt', 'dismissed_at as dismissedAt'])
        .where('event_id', '=', reminder.id)
        .executeTakeFirstOrThrow()
      expect(stored.dismissedAt).not.equals(null)
      expect(stored.viewedAt).not.equals(null)

      // Dismissed, Pending is empty and the bell goes out: the grant never
      // lit it.
      const after = await call('GET', '/me/notifications', OTHER)
      expect(after.body.items).deep.equals([])
      expect(after.body.hasPending).equals(false)
      expect(
        (await call('GET', '/me/notifications/summary', OTHER)).body.hasPending
      ).equals(false)
      const history = await call('GET', '/me/notifications?history=1', OTHER)
      const kept = (history.body.items as Body[]).find(
        item => item.id === reminder.id
      )
      expect(kept?.status).equals('accepted')
      expect(kept?.canAct).equals(false)
      expect(
        (history.body.items as Body[]).some(item => item.id === grantId)
      ).equals(true)

      // Dismissing twice is still a dismissal.
      expect(
        (
          await call(
            'PUT',
            `/me/notifications/${reminder.id}/dismissed`,
            OTHER,
            {}
          )
        ).status
      ).equals(204)
    })

    it('pages on among the reminders after the one a page ended on is dismissed', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const recordedStream = async (
        label: string,
        device: string
      ): Promise<string> => {
        const made = await ask(gameId, phone(label, device), OTHER)
        const marked = await call(
          'PATCH',
          `/games/${gameId}/live-streams/${made.body.id}`,
          OTHER,
          { localRecording: 'recorded' }
        )
        expect(marked.status).equals(200)
        return made.body.id
      }
      const first = await recordedStream('Home Plate', IPHONE)
      const second = await recordedStream('First Base', PIXEL)

      const page = await call('GET', '/me/notifications?limit=1', OTHER)
      const [shown] = page.body.items as Body[]
      expect(shown.liveStreamId).equals(first)
      // Dismissed from the Pending list before the next page is asked for.
      expect(
        (
          await call(
            'PUT',
            `/me/notifications/${shown.id}/dismissed`,
            OTHER,
            {}
          )
        ).status
      ).equals(204)
      const rest = await call(
        'GET',
        `/me/notifications?cursor=${encodeURIComponent(String(page.body.nextCursor))}`,
        OTHER
      )
      const items = rest.body.items as Body[]
      expect(items[0]?.liveStreamId).equals(second)

      // A cursor from before reminders led, or one that is not a cursor.
      const old = await call(
        'GET',
        `/me/notifications?cursor=${encodeURIComponent(`${new Date(0).toISOString()}|x`)}`,
        OTHER
      )
      expect(old.status).equals(200)
      for (const bad of [
        '2|2026-05-02T18:00:00.000Z|x',
        '0|soon|x',
        '0|a|b|c'
      ]) {
        const refused = await call(
          'GET',
          `/me/notifications?cursor=${encodeURIComponent(bad)}`,
          OTHER
        )
        expect(refused.status).equals(403)
      }
    })

    it('says the angle alone when the device gave no model', function () {
      expect(reminderDescription('Home Plate', null)).equals(
        'Home Plate — provide a higher-quality copy for future viewing.'
      )
    })
  })

  describe('S7b the warning that a copy is expiring', function () {
    const DAY = 24 * 60 * 60 * 1000
    /** A recorded camera that ended `days` ago, owned by OTHER. */
    const endedDaysAgo = async (
      gameId: string,
      label: string,
      days: number,
      device = IPHONE
    ): Promise<string> => {
      const made = await ask(gameId, phone(label, device), OTHER)
      expect(made.status).equals(201)
      const marked = await call(
        'PATCH',
        `/games/${gameId}/live-streams/${made.body.id}`,
        OTHER,
        { localRecording: 'recorded' }
      )
      expect(marked.status).equals(200)
      const endedAt = new Date(Date.now() - days * DAY)
      await db!
        .updateTable('live_streams')
        .set({ state: 'ended', ended_at: endedAt, closes_at: endedAt })
        .where('id', '=', made.body.id)
        .execute()
      return made.body.id
    }
    const warned = async (gameId: string): Promise<string[]> =>
      (
        await db!
          .selectFrom('notification_events')
          .innerJoin(
            'live_streams',
            'live_streams.id',
            'notification_events.source_id'
          )
          .select('live_streams.id as id')
          .where('notification_events.source_type', '=', 'localCopyExpiring')
          .where('live_streams.game_id', '=', gameId)
          .execute()
      ).map(row => row.id)

    it('fires once per stream from 27 days up to 28, and reaches the bell', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const before = await endedDaysAgo(gameId, 'Early', 26.9, IPHONE)
      const due = await endedDaysAgo(gameId, 'Home Plate', 27, IPHONE)
      const late = await endedDaysAgo(gameId, 'Backstop', 27.9, IPHONE)
      const past = await endedDaysAgo(gameId, 'Too Old', 28, IPHONE)
      const older = await endedDaysAgo(gameId, 'Long Gone', 31, IPHONE)

      const now = new Date(Date.now() + 1000)
      await recordLocalCopyWarnings(db, now)
      expect((await warned(gameId)).sort()).deep.equals([due, late].sort())
      expect(await warned(gameId)).not.includes(before)
      expect(await warned(gameId)).not.includes(past)
      expect(await warned(gameId)).not.includes(older)
      // The hourly run says nothing twice.
      expect(await recordLocalCopyWarnings(db, now)).equals(0)

      const pending = await call('GET', '/me/notifications', OTHER)
      const items = (pending.body.items as Body[]).filter(
        item => item.type === 'localCopyExpiring'
      )
      const warning = items.find(item => item.liveStreamId === due)!
      expect(warning.title).equals("This phone's copy is expiring")
      expect(warning.description).equals(
        "Home Plate on iPhone 13 Pro, Ridge Demo at Harbor Demo — this phone's copy will be deleted in 3 days. Upload it to keep it."
      )
      expect(warning.status).equals('pending')
      expect(warning.canAct).equals(true)
      expect(warning.gameId).equals(gameId)
      expect(pending.body.hasPending).equals(true)
      expect(
        (await call('GET', '/me/notifications/summary', OTHER)).body.hasPending
      ).equals(true)

      // Only its owner has it.
      expect(
        (
          (await call('GET', '/me/notifications', OWNER)).body.items as Body[]
        ).filter(item => item.liveStreamId === due)
      ).deep.equals([])
    })

    it('leaves alone an uploaded, a removed, a discarded and an unrecorded camera', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const uploaded = await endedDaysAgo(gameId, 'Uploaded', 27.5, IPHONE)
      await db
        .updateTable('live_streams')
        .set({ local_recording: 'uploaded' })
        .where('id', '=', uploaded)
        .execute()
      const removed = await endedDaysAgo(gameId, 'Removed', 27.5, IPHONE)
      await call('PATCH', `/games/${gameId}/live-streams/${removed}`, OTHER, {
        localRecording: 'removed'
      })
      const discarded = await endedDaysAgo(gameId, 'Discarded', 27.5, IPHONE)
      await db
        .updateTable('live_streams')
        .set({ discarded_at: new Date() })
        .where('id', '=', discarded)
        .execute()
      const elsewhere = await endedDaysAgo(gameId, 'Elsewhere', 27.5, IPHONE)
      await db
        .updateTable('live_streams')
        .set({ records_locally: false })
        .where('id', '=', elsewhere)
        .execute()
      await recordLocalCopyWarnings(db)
      expect(await warned(gameId)).deep.equals([])
    })

    it('settles when the phone says the copy has gone', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const due = await endedDaysAgo(gameId, 'Home Plate', 27.5, IPHONE)
      await recordLocalCopyWarnings(db)
      const listed = async (): Promise<Body[]> =>
        (
          (await call('GET', '/me/notifications', OTHER)).body.items as Body[]
        ).filter(item => item.liveStreamId === due)
      expect(
        (await listed()).map(item => String(item.type)).sort()
      ).deep.equals(['localCopyExpiring', 'recordingUpload'])
      await call('PATCH', `/games/${gameId}/live-streams/${due}`, OTHER, {
        localRecording: 'removed'
      })
      expect(await listed()).deep.equals([])
    })

    it('says the angle and game alone when the device gave no model', function () {
      expect(
        localCopyWarningDescription('Home Plate', null, 'Owls at Hawks')
      ).equals(
        "Home Plate, Owls at Hawks — this phone's copy will be deleted in 3 days. Upload it to keep it."
      )
    })
  })

  describe('S8 limits, and ended cameras that stay', function () {
    const SEVENTH = 'This game already has 6 cameras. End one to add another.'
    const FIFTH =
      'You already have 4 cameras on this game. End one to add another.'
    const list = async (gameId: string, token = OWNER): Promise<Body> => {
      const listed = await call('GET', `/games/${gameId}/live-streams`, token)
      expect(listed.status).equals(200)
      return listed.body
    }
    /** Four of the owner's and two of the other manager's. */
    const fullGame = async (gameId: string): Promise<string[]> => {
      const made: string[] = []
      for (const label of ['One', 'Two', 'Three', 'Four']) {
        const answer = await ask(gameId, { label })
        expect(answer.status).equals(201)
        made.push(answer.body.id)
      }
      for (const label of ['Five', 'Six']) {
        const answer = await ask(gameId, { label }, OTHER)
        expect(answer.status).equals(201)
        made.push(answer.body.id)
      }
      return made
    }
    const discard = async (
      gameId: string,
      streamId: string,
      token = OWNER
    ): Promise<{ status: number; body: Body }> =>
      await call(
        'POST',
        `/games/${gameId}/live-streams/${streamId}/discard`,
        token
      )
    const uploadFor = async (
      gameId: string,
      streamId: string,
      state: 'ready' | 'open',
      videoId: string | null,
      createdAt = new Date()
    ): Promise<string> => {
      const id = makeId('directorUpload')
      await db!
        .insertInto('director_uploads')
        .values({
          id,
          user_id: userIdOfGumbo(owner.userId),
          game_id: gameId,
          title: 'Home Plate recording',
          filename: 'home-plate.mp4',
          size_bytes: '20',
          part_size: 10,
          state,
          video_id: videoId,
          live_stream_id: streamId,
          created_at: createdAt
        })
        .execute()
      return id
    }
    const madeVideo = async (
      gameId: string,
      patch: { hidden?: boolean; durationSec?: number } = {}
    ): Promise<string> => {
      const id = makeId('video')
      await db!
        .insertInto('videos')
        .values({
          id,
          game_id: gameId,
          kind: 'program',
          title: 'What the app called it',
          storage: 'local',
          status: 'ready',
          hidden: patch.hidden === true,
          duration_sec: patch.durationSec ?? 600,
          created_at: new Date(),
          updated_at: new Date()
        })
        .execute()
      return id
    }
    const exists = async (videoId: string): Promise<boolean> =>
      (await db!
        .selectFrom('videos')
        .select('id')
        .where('id', '=', videoId)
        .executeTakeFirst()) != null

    it('lets an ended camera free its slot and stay listed', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const first = await ask(gameId, { label: 'One' })
      await ask(gameId, { label: 'Two' })
      await ask(gameId, { label: 'Three' })
      await ask(gameId, { label: 'Four' })
      expect((await list(gameId)).canAdd).equals(0)
      await end(gameId, first.body.id)

      const listed = await list(gameId)
      expect(listed.canAdd).equals(1)
      expect(listed.mine.map((row: Body) => row.label)).deep.equals([
        'Two',
        'Three',
        'Four',
        'One'
      ])

      const fifth = await ask(gameId, { label: 'Five' })
      expect(fifth.status).equals(201)
      expect(fifth.body.slot).equals(1)
      expect((await list(gameId)).mine).has.lengthOf(5)
    })

    it('counts a closing camera as ended, while it is still publishing', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const first = await ask(gameId, phone('Home Plate'))
      await db
        .updateTable('live_streams')
        .set({ state: 'publishing', closes_at: new Date() })
        .where('id', '=', first.body.id)
        .execute()
      expect((await list(gameId)).canAdd).equals(4)
      const again = await ask(gameId, phone('Home Plate'))
      expect(again.status).equals(201)
      expect(again.body.slot).equals(1)
    })

    it('frees the slot and name of a stream the ingest finished without an End', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const first = await ask(gameId, phone('Home Plate'))
      await db
        .updateTable('live_streams')
        .set({ state: 'ended', ended_at: new Date() })
        .where('id', '=', first.body.id)
        .execute()
      const again = await ask(gameId, phone('Home Plate'))
      expect(again.status).equals(201)
      expect(again.body.slot).equals(1)
      expect(await streamsOn(gameId)).equals(2)
    })

    it('refuses a fifth concurrent camera on every create path', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      for (const label of ['One', 'Two', 'Three', 'Four']) {
        expect((await ask(gameId, { label })).status).equals(201)
      }
      for (const refused of [
        await ask(gameId, { label: 'Five' }),
        await ask(gameId, phone('Five')),
        await ask(gameId, { label: 'Five', source: 'gopro' })
      ]) {
        expect(refused.status).equals(400)
        expect(refused.body.message).equals(FIFTH)
      }
      expect(await streamsOn(gameId)).equals(4)
    })

    it('refuses a seventh on the game for each create path, and counts a Director', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      for (const label of ['One', 'Two', 'Three']) {
        expect((await ask(gameId, phone(label))).status).equals(201)
      }
      expect((await claim(gameId, 'Director')).status).equals(200)
      const fifth = await ask(gameId, phone('Five', PIXEL), OTHER)
      expect(fifth.status).equals(201)
      const sixth = await ask(gameId, phone('Six', PIXEL), OTHER)
      expect(sixth.status).equals(201)
      expect(await streamsOn(gameId)).equals(6)

      for (const refused of [
        await ask(gameId, { label: 'Seven' }, OTHER),
        await ask(gameId, phone('Seven', PIXEL), OTHER),
        await claim(gameId, 'Seven', OTHER)
      ]) {
        expect(refused.status).equals(400)
        expect(refused.body.message).equals(SEVENTH)
      }
      expect(await streamsOn(gameId)).equals(6)

      await call(
        'POST',
        `/games/${gameId}/live-streams/${fifth.body.id}/end`,
        OTHER
      )
      expect((await ask(gameId, { label: 'Seven' }, OTHER)).status).equals(201)
    })

    it('never lets two creates at once pass the limit', async function () {
      if (db == null) this.skip()
      for (let round = 0; round < 4; round += 1) {
        const gameId = await newGame()
        for (const label of ['One', 'Two', 'Three', 'Four']) {
          expect((await ask(gameId, phone(label))).status).equals(201)
        }
        const fifth = await ask(gameId, phone('Five', PIXEL), OTHER)
        expect(fifth.status).equals(201)
        const answers = await Promise.all([
          ask(gameId, { label: 'Six' }, OTHER),
          ask(gameId, phone('Seven', PIXEL), OTHER),
          ask(gameId, phone('Eight', IPAD), OTHER)
        ])
        expect(answers.filter(one => one.status === 201)).has.lengthOf(1)
        expect(answers.filter(one => one.status === 400)).has.lengthOf(2)
        expect(await streamsOn(gameId)).equals(6)
      }
    })

    it('leaves both rows when an ended name is recorded again', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const first = await ask(gameId, phone('Home Plate'))
      await end(gameId, first.body.id)
      const second = await ask(gameId, phone('Home Plate'))
      expect(second.status).equals(201)

      const { mine } = await list(gameId)
      expect(mine.map((row: Body) => row.id)).deep.equals([
        second.body.id,
        first.body.id
      ])
      expect(mine.map((row: Body) => row.label)).deep.equals([
        'Home Plate',
        'Home Plate'
      ])
    })

    it('puts active rows first in mine, each oldest first', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const one = await ask(gameId, phone('One'))
      const two = await ask(gameId, phone('Two'))
      const three = await ask(gameId, phone('Three'))
      await end(gameId, one.body.id)
      const four = await ask(gameId, phone('One'))
      expect((await list(gameId)).mine.map((row: Body) => row.id)).deep.equals([
        two.body.id,
        three.body.id,
        four.body.id,
        one.body.id
      ])
    })

    it('answers canAdd and gameCanAdd as the room left, counting active cameras', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      expect(await list(gameId)).includes({ canAdd: 4, gameCanAdd: 6 })
      const made = await fullGame(gameId)
      expect(await list(gameId)).includes({ canAdd: 0, gameCanAdd: 0 })
      expect(await list(gameId, OTHER)).includes({ canAdd: 0, gameCanAdd: 0 })
      await end(gameId, made[0])
      expect(await list(gameId)).includes({ canAdd: 1, gameCanAdd: 1 })
      expect(await list(gameId, OTHER)).includes({ canAdd: 1, gameCanAdd: 1 })
    })

    it('says each list item’s row data, for a device stream and an external camera', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const gopro = await ask(gameId, {
        label: 'Backstop',
        deviceId: IPAD,
        source: 'gopro'
      })
      expect(gopro.status).equals(201)
      expect(gopro.body.deviceId).equals(undefined)
      expect((await stream(gopro.body.id)).deviceId).equals(null)
      const heard = new Date('2026-05-20T16:00:00.000Z')
      const finished = new Date('2026-05-20T17:00:00.000Z')
      await db
        .updateTable('live_streams')
        .set({
          state: 'ended',
          first_published_at: heard,
          ended_at: finished
        })
        .where('id', '=', made.body.id)
        .execute()
      await db
        .updateTable('users')
        .set({ avatar_path: null })
        .where('id', '=', userIdOfGumbo(owner.userId))
        .execute()

      const { mine } = await list(gameId)
      const [external, phoneRow] = mine as Body[]
      expect(external.source).equals('gopro')
      expect(external.publishedAt).equals(null)
      expect(phoneRow.source).equals(null)
      expect(phoneRow.publishedAt).equals(heard.toISOString())
      expect(phoneRow.endedAt).equals(finished.toISOString())
      expect(Date.parse(phoneRow.createdAt)).is.a('number')
      expect(phoneRow.ownerPicture).equals(null)
      expect(phoneRow.playableVideoId).equals(null)
      expect(phoneRow.durationSec).equals(null)

      const refused = await ask(gameId, { label: 'Odd', source: 'vhs' })
      expect(refused.status).equals(400)
    })

    it('plays the newest finished visible upload, then the visible live video, then nothing', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const liveVideo = String(made.body.videoId)
      await end(gameId, made.body.id)
      const row = async (): Promise<Body> => (await list(gameId)).mine[0]

      // Hidden until video arrives.
      expect((await row()).playableVideoId).equals(null)
      await db
        .updateTable('videos')
        .set({ hidden: false, status: 'ready', duration_sec: 120 })
        .where('id', '=', liveVideo)
        .execute()
      expect(await row()).includes({
        playableVideoId: liveVideo,
        durationSec: 120
      })

      const hiddenUpload = await madeVideo(gameId, { hidden: true })
      await uploadFor(gameId, made.body.id, 'ready', hiddenUpload)
      const standalone = await madeVideo(gameId, { durationSec: 300 })
      await uploadFor(
        gameId,
        made.body.id,
        'ready',
        standalone,
        new Date(Date.now() - 60_000)
      )
      await uploadFor(gameId, made.body.id, 'open', null)
      expect(await row()).includes({
        playableVideoId: standalone,
        durationSec: 300
      })
    })

    it('keeps an uploaded camera listed as ended, with its upload to play', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      await db
        .updateTable('videos')
        .set({ hidden: false, status: 'ready', duration_sec: 600 })
        .where('id', '=', made.body.videoId)
        .execute()
      await end(gameId, made.body.id)
      const upload = await madeVideo(gameId, { durationSec: 590 })
      await uploadFor(gameId, made.body.id, 'ready', upload)
      expect(
        await replaceLiveRecording(db, gameId, upload, {
          liveStreamId: made.body.id,
          wholeStream: true
        })
      ).deep.equals([made.body.videoId])

      const [row] = (await list(gameId)).mine as Body[]
      expect(row.id).equals(made.body.id)
      expect(row.state).equals('ended')
      expect(row.localRecording).equals('uploaded')
      expect(row.playableVideoId).equals(upload)
      expect(row.durationSec).equals(590)
      expect((await list(gameId)).canAdd).equals(4)
    })

    it('still answers reveal and PATCH for an uploaded camera, and its key cannot publish', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      await end(gameId, made.body.id)
      const upload = await madeVideo(gameId)
      await replaceLiveRecording(db, gameId, upload, {
        liveStreamId: made.body.id,
        wholeStream: true
      })
      const path = `/games/${gameId}/live-streams/${made.body.id}`
      const revealed = await call('POST', `${path}/reveal`, OWNER)
      expect(revealed.status).equals(200)
      expect(revealed.body.url).equals(made.body.url)
      const renamed = await call('PATCH', path, OWNER, { label: 'Backstop' })
      expect(renamed.status).equals(200)
      expect(renamed.body.label).equals('Backstop')

      const key = String(made.body.url).split('/').pop() ?? ''
      expect(
        await resolveKey(key, {
          db,
          live: LIVE,
          ffmpegPath: '/not-used',
          mediaRoot: uploadsDir,
          workDir: uploadsDir,
          sessionSecret: 'k'.repeat(32)
        })
      ).equals('This game’s stream has already finished.')
    })

    it('lets only the owner discard, and only once a camera has stopped', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))

      const active = await discard(gameId, made.body.id)
      expect(active.status).equals(400)
      expect(active.body.message).equals(
        'That camera is still running. End it first.'
      )

      await db
        .updateTable('live_streams')
        .set({ state: 'publishing', closes_at: new Date() })
        .where('id', '=', made.body.id)
        .execute()
      expect((await discard(gameId, made.body.id)).status).equals(400)

      await db
        .updateTable('live_streams')
        .set({ state: 'ended', ended_at: new Date() })
        .where('id', '=', made.body.id)
        .execute()
      expect((await discard(gameId, made.body.id, OTHER)).status).equals(404)
      expect((await discard(gameId, made.body.id, PARENT)).status).equals(404)
      expect((await list(gameId)).mine).has.lengthOf(1)
      expect((await discard(gameId, made.body.id)).status).equals(200)
    })

    it('deletes the live video and its uploads, leaves the list, and says which it dropped', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const kept = await ask(gameId, phone('First Base'))
      const liveVideo = String(made.body.videoId)
      await db
        .updateTable('videos')
        .set({ hidden: false, status: 'ready', duration_sec: 600 })
        .where('id', '=', liveVideo)
        .execute()
      await end(gameId, made.body.id)
      const upload = await madeVideo(gameId)
      await uploadFor(gameId, made.body.id, 'ready', upload)
      await replaceLiveRecording(db, gameId, upload, {
        liveStreamId: made.body.id,
        wholeStream: true
      })

      const answer = await discard(gameId, made.body.id)
      expect(answer.status).equals(200)
      expect(answer.body.mine.map((row: Body) => row.id)).deep.equals([
        kept.body.id
      ])
      expect(answer.body.discarded).deep.equals([made.body.id])
      expect(await exists(liveVideo)).equals(false)
      expect(await exists(upload)).equals(false)
      // Only the owner's list says so.
      expect((await list(gameId, OTHER)).discarded).deep.equals([])
    })

    it('removes a standalone upload and settles the reminder', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      const marked = await call(
        'PATCH',
        `/games/${gameId}/live-streams/${made.body.id}`,
        OWNER,
        { localRecording: 'recorded' }
      )
      expect(marked.status).equals(200)
      await end(gameId, made.body.id)
      const upload = await madeVideo(gameId)
      await uploadFor(gameId, made.body.id, 'ready', upload)

      expect((await discard(gameId, made.body.id)).status).equals(200)
      expect(await exists(upload)).equals(false)
      const receipt = await db
        .selectFrom('notification_receipts')
        .innerJoin(
          'notification_events',
          'notification_events.id',
          'notification_receipts.event_id'
        )
        .select('notification_receipts.dismissed_at as dismissedAt')
        .where('notification_events.source_id', '=', made.body.id)
        .executeTakeFirstOrThrow()
      expect(receipt.dismissedAt).not.equals(null)
    })

    it('discards a camera with no video left', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, { label: 'Backstop' })
      await end(gameId, made.body.id)
      await db
        .deleteFrom('videos')
        .where('id', '=', made.body.videoId)
        .execute()
      expect((await discard(gameId, made.body.id)).status).equals(200)
    })

    it('refuses an upload opened or finished for a discarded stream, and drops one already under way', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await ask(gameId, phone('Home Plate'))
      await end(gameId, made.body.id)
      const waiting = await call('POST', '/director/uploads', OWNER, {
        gameId,
        title: 'Home Plate recording',
        filename: 'home-plate.mp4',
        sizeBytes: 20,
        liveStreamId: made.body.id
      })
      expect(waiting.status).equals(201)
      expect((await discard(gameId, made.body.id)).status).equals(200)

      const opened = await call('POST', '/director/uploads', OWNER, {
        gameId,
        title: 'Home Plate recording',
        filename: 'home-plate.mp4',
        sizeBytes: 20,
        liveStreamId: made.body.id
      })
      expect(opened.status).equals(410)
      const finished = await call(
        'POST',
        `/director/uploads/${waiting.body.uploadId}/finish`,
        OWNER
      )
      expect(finished.status).equals(410)

      const late = await madeVideo(gameId)
      expect(
        await replaceLiveRecording(
          db,
          gameId,
          late,
          { liveStreamId: made.body.id, wholeStream: true },
          { space: NO_SPACE, mediaRoot: uploadsDir }
        )
      ).deep.equals([])
      expect(await exists(late)).equals(false)
    })
  })

  describe('S9 a publish refused for its codec', function () {
    const REFUSAL = 'TeamStation takes HEVC. This stream is H.264.'

    const ingest = (): Parameters<typeof beganPublishing>[0] => ({
      db: db!,
      live: LIVE,
      ffmpegPath: '/not-used',
      mediaRoot: uploadsDir,
      workDir: uploadsDir,
      sessionSecret: 'k'.repeat(32)
    })

    const external = async (gameId: string): Promise<Body> =>
      (await ask(gameId, { label: 'Backstop', source: 'rtmp' })).body

    const keyOf = (made: Body): string => String(made.url).split('/').pop()!

    /** What the controller hears of H.264: nothing until it is refused. */
    const refuse = async (made: Body): Promise<void> => {
      const key = keyOf(made)
      await handleLiveEventForTest(
        { type: 'rejected', key, reason: REFUSAL },
        ingest()
      )
      await handleLiveEventForTest(
        {
          type: 'publishEnded',
          key,
          liveStreamId: made.id,
          reason: REFUSAL
        },
        ingest()
      )
    }

    /** The folder the ingest makes for a camera's key. */
    const folderOf = async (made: Body): Promise<string> => {
      const { videoId } = await stream(made.id)
      const dir = liveVideoDir(uploadsDir, videoId!)
      await mkdir(dir, { recursive: true })
      return dir
    }

    const revoke = async (
      gameId: string,
      streamId: string,
      token = OWNER
    ): ReturnType<typeof call> =>
      await call(
        'POST',
        `/games/${gameId}/live-streams/${streamId}/revoke`,
        token
      )

    const videoExists = async (videoId: string): Promise<boolean> =>
      (await db!
        .selectFrom('videos')
        .select('id')
        .where('id', '=', videoId)
        .executeTakeFirst()) != null

    const folderGone = async (dir: string): Promise<boolean> =>
      (await readdir(dir).catch(() => 'gone')) === 'gone'

    const row = async (gameId: string, streamId: string): Promise<Body> => {
      const listed = await call('GET', `/games/${gameId}/live-streams`, OWNER)
      return (listed.body.mine as Body[]).find(one => one.id === streamId)!
    }

    it('reads as never published, so Revoke takes the camera, its video and its files', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await external(gameId)
      const { videoId } = await stream(made.id)
      const dir = await folderOf(made)
      await refuse(made)

      const shown = await row(gameId, made.id)
      expect(shown.publishedAt).equals(null)
      expect(shown.state).equals('idle')
      expect(shown.lastError).equals(REFUSAL)

      const revoked = await revoke(gameId, made.id)
      expect(revoked.status).equals(200)
      expect(revoked.body.removed).equals(true)
      expect(revoked.body.streams.mine).deep.equals([])

      expect(await row(gameId, made.id), 'the row went').equals(undefined)
      expect(await videoExists(videoId!), 'the video went').equals(false)
      expect(await folderGone(dir), 'the folder went').equals(true)
    })

    it('counts a later good publish from that publish', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await external(gameId)
      const { videoId } = await stream(made.id)
      await refuse(made)

      await new Promise(resolve => setTimeout(resolve, 5))
      const good = Date.now()
      await beganPublishing(ingest(), made.id)

      const shown = await row(gameId, made.id)
      expect(shown.state).equals('publishing')
      expect(shown.lastError).equals(null)
      expect(Date.parse(shown.publishedAt)).is.at.least(good)
      const placed = await db
        .selectFrom('videos')
        .select(['start_at as startAt', 'hidden'])
        .where('id', '=', videoId!)
        .executeTakeFirstOrThrow()
      expect(placed.hidden).equals(false)
      expect(placed.startAt?.getTime()).is.at.least(good)
    })

    it('stays published when the refusal follows a real publish', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const made = await external(gameId)
      await beganPublishing(ingest(), made.id)
      await handleLiveEventForTest(
        {
          type: 'publishEnded',
          key: keyOf(made),
          liveStreamId: made.id,
          reason: 'The stream ended'
        },
        ingest()
      )
      const first = (await row(gameId, made.id)).publishedAt
      expect(first).not.equals(null)

      await new Promise(resolve => setTimeout(resolve, 5))
      await refuse(made)

      const shown = await row(gameId, made.id)
      expect(shown.publishedAt).equals(first)
      expect(shown.lastError).equals(REFUSAL)
    })

    describe('Revoke', function () {
      it('removes a camera with an attempt in flight, and the refusal then lands on nothing', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)
        const { videoId } = await stream(made.id)
        const dir = await folderOf(made)

        // An encoder has connected and the sampler has yet to look at it.
        expect((await revoke(gameId, made.id)).body.removed).equals(true)
        await refuse(made)

        expect(await row(gameId, made.id)).equals(undefined)
        expect(await videoExists(videoId!)).equals(false)
        expect(await folderGone(dir)).equals(true)
      })

      it('copes with a refusal for a row that is gone altogether', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)
        await revoke(gameId, made.id)
        await db.deleteFrom('live_streams').where('id', '=', made.id).execute()
        await refuse(made)
      })

      it('turns away an attempt just after it, and makes no folder', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)
        const { videoId } = await stream(made.id)
        await revoke(gameId, made.id)

        const answer = await resolveKey(keyOf(made), ingest())
        expect(answer).to.be.a('string')
        expect(await folderGone(liveVideoDir(uploadsDir, videoId!))).equals(
          true
        )
      })

      it('wins over a publish accepted after it: no stamp, no video', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)
        const { videoId } = await stream(made.id)
        await revoke(gameId, made.id)

        await beganPublishing(ingest(), made.id)

        const left = await db
          .selectFrom('live_streams')
          .select(['state', 'first_published_at as first'])
          .where('id', '=', made.id)
          .executeTakeFirstOrThrow()
        expect(left).deep.equals({ state: 'revoked', first: null })
        expect(await videoExists(videoId!)).equals(false)
      })

      it('only ends a camera with a real publish, even after a refusal', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)
        const { videoId } = await stream(made.id)
        const dir = await folderOf(made)
        await writeFile(join(dir, 'master.m3u8'), '#EXTM3U\n')
        await beganPublishing(ingest(), made.id)
        await handleLiveEventForTest(
          {
            type: 'publishEnded',
            key: keyOf(made),
            liveStreamId: made.id,
            reason: 'The stream ended'
          },
          ingest()
        )
        const first = (await row(gameId, made.id)).publishedAt
        await refuse(made)

        const revoked = await revoke(gameId, made.id)
        expect(revoked.body.removed).equals(false)

        const shown = await row(gameId, made.id)
        expect(shown.publishedAt).equals(first)
        expect(shown.closesAt).not.equals(null)
        expect(shown.state).not.equals('revoked')
        expect(await videoExists(videoId!), 'the recording stays').equals(true)
        expect(await folderGone(dir), 'its files stay').equals(false)
      })

      it('only ends a camera live now, while it is publishing', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)
        await beganPublishing(ingest(), made.id)

        expect((await revoke(gameId, made.id)).body.removed).equals(false)
        expect((await row(gameId, made.id)).state).equals('publishing')
        expect((await row(gameId, made.id)).closesAt).not.equals(null)
      })

      it('goes by the row, not by what a list said a moment ago', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)
        const stale = await row(gameId, made.id)
        expect(stale.publishedAt).equals(null)
        await beganPublishing(ingest(), made.id)

        expect((await revoke(gameId, made.id)).body.removed).equals(false)
      })

      it('leaves when it was ended first, as it is when it never published', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)
        await end(gameId, made.id)
        const closed = (await row(gameId, made.id)).closesAt
        expect(closed).not.equals(null)

        expect((await revoke(gameId, made.id)).body.removed).equals(true)
        expect(await row(gameId, made.id)).equals(undefined)
      })

      it('keeps the closing time of a published camera already ended', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)
        await beganPublishing(ingest(), made.id)
        await end(gameId, made.id)
        const closed = (await row(gameId, made.id)).closesAt
        await new Promise(resolve => setTimeout(resolve, 5))

        expect((await revoke(gameId, made.id)).body.removed).equals(false)
        expect((await row(gameId, made.id)).closesAt).equals(closed)
      })

      it('only ends a camera whose recording was uploaded', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)
        await db
          .updateTable('live_streams')
          .set({ local_recording: 'uploaded' })
          .where('id', '=', made.id)
          .execute()

        expect((await revoke(gameId, made.id)).body.removed).equals(false)
        expect(await row(gameId, made.id)).not.equals(undefined)
      })

      it('is for the camera’s owner alone, and 404s for anyone else', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)

        expect((await revoke(gameId, made.id, OTHER)).status).equals(404)
        expect((await revoke(gameId, 'liv_nobody')).status).equals(404)
        const shown = await row(gameId, made.id)
        expect(shown.closesAt).equals(null)
      })

      it('waits its turn under the game’s lock', async function () {
        if (db == null) this.skip()
        const gameId = await newGame()
        const made = await external(gameId)

        let answered = false
        let revoking: ReturnType<typeof revoke> | undefined
        await db.transaction().execute(async trx => {
          await lockKeys(trx, [`liveStreams:${gameId}`])
          revoking = revoke(gameId, made.id).finally(() => {
            answered = true
          })
          await new Promise(resolve => setTimeout(resolve, 150))
          expect(answered, 'it waited for the lock').equals(false)
        })
        expect((await revoking)?.body.removed).equals(true)
      })
    })
  })

  describe('requestDeviceStream under the game’s lock', function () {
    it('gives two simultaneous requests from one device the same stream', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const request = {
        gameId,
        teamId: 'tem_home',
        startAt: new Date(),
        videoTitle: 'Ridge Demo at Harbor Demo',
        userId: userIdOfGumbo(owner.userId),
        deviceId: IPHONE,
        deviceModel: 'iPhone 13 Pro',
        label: 'Home Plate',
        recordsLocally: true,
        live: LIVE,
        sessionSecret: 'k'.repeat(32)
      }
      const [a, b] = await Promise.all([
        requestDeviceStream(db, request),
        requestDeviceStream(db, request)
      ])
      expect(a.row.id).equals(b.row.id)
      expect(a.key).equals(b.key)
      expect([a.created, b.created].filter(Boolean)).deep.equals([true])
    })

    it('never hands streaming software a phone’s stream when both ask at once', async function () {
      if (db == null) this.skip()
      for (let round = 0; round < 8; round += 1) {
        const gameId = await newGame()
        const [device, browser] = await Promise.all([
          ask(gameId, phone('Home Plate')),
          ask(gameId, { label: 'Encoder' })
        ])
        expect(device.status).equals(201)
        expect(browser.status).equals(201)
        expect(browser.body.id).not.equals(device.body.id)
        expect(browser.body.url).not.equals(device.body.url)
        expect(
          [device.body.slot, browser.body.slot].sort((a, b) => a - b)
        ).deep.equals([1, 2])
      }
    })
  })
})
