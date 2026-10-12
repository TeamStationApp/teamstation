import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { requestDeviceStream } from '../live/streamKeys'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import {
  recordRecordingReminder,
  reminderDescription
} from '../notifications/recordingReminders'
import { directorRoutes } from './director'
import { directorUploadRoutes, replaceLiveRecording } from './directorUploads'
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
    app.use('/api/v1', liveRoutes(db, { live: LIVE, sessionSecret, host }))
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
        ffmpegPath: '/usr/bin/ffmpeg',
        space: {
          bucket: 'test',
          region: 'sfo3',
          endpoint: 'https://space.example.test',
          accessKeyId: 'k',
          secretAccessKey: 's'
        }
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
      await db
        .insertInto('users')
        .values({
          id: made.userId,
          legacyId: made.legacyId,
          display_name: name,
          first_name: null,
          last_name: null,
          login_enabled: true,
          created_at: now,
          updated_at: now
        })
        .execute()
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
          user_id: user,
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
        .values({ id, user_id: user, team_id: 'tem_home', role })
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
        .where('user_id', '=', owner.userId)
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
      const old = await stream(first.body.id)
      expect(old.state).equals('revoked')
      expect(old.videoId).equals(first.body.videoId)

      // Replaced by an upload: revoked, so its name and slot are free.
      await db
        .updateTable('live_streams')
        .set({ state: 'revoked', local_recording: 'uploaded' })
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
      expect((await stream(made.body.id)).state).equals('revoked')
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
      // An explicit start goes live again on a fresh stream.
      const start = await ask(gameId, phone('Home Plate'))
      expect(start.status).equals(201)
      expect((await stream(made.body.id)).state).equals('revoked')
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
          .where('user_id', '=', other.userId)
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

    it('ignores a liveStreamId it may not use, and the upload still opens', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const elsewhere = await newGame()
      const theirs = await ask(gameId, phone('Home Plate'), OTHER)
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
        theirs.body.id,
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
        expect(await uploadRow(opened.body.uploadId), named).deep.equals({
          liveStreamId: null,
          wholeStream: false
        })
      }
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

    it('replaces an ended angle that a new take has since revoked, and clears its reminder', async function () {
      if (db == null) this.skip()
      const gameId = await newGame()
      const take1 = await ask(gameId, phone('Home Plate'))
      const liveVideo = await aired(take1.body.id, 0, 600)
      await recorded(gameId, take1.body.id)
      await end(gameId, take1.body.id)
      const take2 = await ask(gameId, phone('Home Plate'))
      expect(take2.status).equals(201)
      expect((await stream(take1.body.id)).state).equals('revoked')

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
      expect(after.state).equals('revoked')
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
          actor_id: owner.userId,
          metadata: { title: 'Mookie Betts added you to Harbor Demo' },
          recorded_recipients: [other.userId],
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
      const [reminder, grant] = pending.body.items as Body[]
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

      // A page at a time, the reminder still leads.
      const page = await call('GET', '/me/notifications?limit=1', OTHER)
      expect((page.body.items as Body[])[0].id).equals(reminder.id)
      const rest = await call(
        'GET',
        `/me/notifications?limit=1&cursor=${encodeURIComponent(String(page.body.nextCursor))}`,
        OTHER
      )
      expect((rest.body.items as Body[]).map(item => item.id)).deep.equals([
        grantId
      ])

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

      const after = await call('GET', '/me/notifications', OTHER)
      expect((after.body.items as Body[]).map(item => item.id)).deep.equals([
        grantId
      ])
      const history = await call('GET', '/me/notifications?history=1', OTHER)
      const kept = (history.body.items as Body[]).find(
        item => item.id === reminder.id
      )
      expect(kept?.status).equals('accepted')
      expect(kept?.canAct).equals(false)

      // With the grant opened, nothing is pending any more.
      await call('PUT', `/me/notifications/${grantId}/viewed`, OTHER, {})
      expect(
        (await call('GET', '/me/notifications/summary', OTHER)).body.hasPending
      ).equals(false)

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

    it('says the angle alone when the device gave no model', function () {
      expect(reminderDescription('Home Plate', null)).equals(
        'Home Plate — provide a higher-quality copy for future viewing.'
      )
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
        userId: owner.userId,
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
  })
})
