import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import type { MediaContext } from '../media/mediaContext'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { directorRoutes } from './director'
import { eventListRoutes } from './eventList'

/**
 * The games TS Director is offered, which Paul specified to the row.
 *
 * `GET /events?scope=film` is soonest first, reaching two hours backwards — a
 * game called for one o'clock that somebody starts filming at ten past three
 * is still the game they mean — and the Director asks for ten, because a
 * longer list is a worse one. Of the games the account **films** — a
 * videographer of the team, which its administrators are — not the games it
 * may watch: a parent's forty watchable games would bury the one they are
 * holding a camera for.
 */

const NEXT_TEN = '/events?scope=film&lookbackHours=2&limit=10'
const NEXT_TWENTY = '/events?scope=film&lookbackHours=2&limit=20'

const media: MediaContext = {
  ffmpegPath: 'ffmpeg',
  mediaRoot: '/tmp',
  mediaSecret: 'secret',
  publicUrl: 'http://127.0.0.1',
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: false
  }
}
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_director_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const COACH = 'tok_coach_00000000000000000000000'
const PARENT = 'tok_parent_0000000000000000000000'
const SECOND = 'tok_second_0000000000000000000000'
const FILMER = 'tok_filmer_0000000000000000000000'
const SCORER = 'tok_scorer_0000000000000000000000'
const HOUR = 3_600_000

const legacyOf = new Map<number, string>()
function mintUser(): number {
  const made = mintUserId(id => legacyOf.has(id))
  legacyOf.set(made.userId, made.legacyId)
  return made.userId
}
function legacyId(userId: number): string {
  const id = legacyOf.get(userId)
  if (id == null) throw new Error(`no legacy id for ${userId}`)
  return id
}

const coachId = mintUser()
const parentId = mintUser()
const filmerId = mintUser()
const scorerId = mintUser()

describe('what TS Director is offered', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''

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
    await seed(db)

    const app = express()
    app.use(express.json())
    app.use(withActor(db))
    app.use(withAudit(db))
    app.use('/api/v1', eventListRoutes(db, media))
    app.use(
      '/api/v1',
      directorRoutes(db, {
        live: {
          enabled: true,
          bindHost: '0.0.0.0',
          port: 1936,
          app: 'live',
          segmentSeconds: 4,
          freeDiskFloorGb: 10
        },
        sessionSecret: 'k'.repeat(32),
        host: 'live.example',
        deviceLabel: 'TS Director'
      })
    )
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    const address = server.address() as AddressInfo
    base = `http://127.0.0.1:${address.port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  /**
   * A coach who runs one team and a parent who runs none, and games at every
   * distance either side of now: three hours ago, one hour ago, and a run of
   * them into the future.
   */
  async function seed(db: Kysely<Database>): Promise<void> {
    const now = new Date()
    for (const [id, name] of [
      [coachId, 'Coach'],
      [parentId, 'Parent'],
      [filmerId, 'Filmer'],
      [scorerId, 'Scorer']
    ] as Array<[number, string]>) {
      await insertFixtureUsers(db, {
        id,
        legacyId: legacyId(id),
        display_name: name,
        first_name: null,
        last_name: null,
        created_at: now,
        updated_at: now
      })
    }
    for (const [id, user, token] of [
      ['ses_coach', coachId, COACH],
      ['ses_parent', parentId, PARENT],
      ['ses_filmer', filmerId, FILMER],
      ['ses_scorer', scorerId, SCORER]
    ] as Array<[string, number, string]>) {
      await db
        .insertInto('auth_sessions')
        .values({
          id,
          user_id: userIdOfGumbo(user),
          token_hash: hashToken(token),
          expires_at: new Date(now.getTime() + HOUR),
          created_at: now
        })
        .execute()
    }
    for (const [id, name] of [
      ['tem_ours', 'Ravens'],
      ['tem_theirs', 'Titan'],
      ['tem_strangers', 'Somebody Else']
    ]) {
      await db
        .insertInto('teams')
        .values({ id, name, created_at: now, updated_at: now })
        .execute()
    }
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_coach',
        user_id: userIdOfGumbo(coachId),
        team_id: 'tem_ours',
        role: 'manager'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_parent',
        user_id: userIdOfGumbo(parentId),
        team_id: 'tem_ours',
        role: 'member'
      })
      .execute()

    // A videographer of the team and a scorekeeper of it, neither of them
    // running anything.
    for (const [userId, role] of [
      [filmerId, 'videographer'],
      [scorerId, 'scorekeeper']
    ] as const) {
      await db
        .insertInto('memberships')
        .values({
          id: `mem_${role}`,
          user_id: userIdOfGumbo(userId),
          team_id: 'tem_ours',
          role: 'member'
        })
        .execute()
      await db
        .insertInto('scope_roles')
        .values({
          id: `rol_${role}`,
          user_id: userIdOfGumbo(userId),
          scope_type: 'team',
          scope_id: 'tem_ours',
          role
        })
        .execute()
    }

    /** Our team's games, at hours either side of now. */
    const ours: Array<[string, number]> = [
      ['gam_longGone', -3],
      ['gam_thisAfternoon', -1],
      ['gam_next', 1],
      ['gam_later', 2],
      ['gam_third', 3],
      ['gam_fourth', 4],
      ['gam_fifth', 5],
      ['gam_sixth', 6],
      ['gam_seventh', 7],
      ['gam_eighth', 8],
      ['gam_ninth', 9],
      ['gam_tenth', 10],
      ['gam_eleventh', 11]
    ]
    for (const [id, offset] of ours) {
      await db
        .insertInto('games')
        .values({
          id,
          home_team_id: 'tem_ours',
          away_team_id: 'tem_theirs',
          start_at: new Date(now.getTime() + offset * HOUR),
          created_at: now,
          updated_at: now
        })
        .execute()
    }
    // Somebody else's game, an hour from now: nothing to do with this account.
    await db
      .insertInto('games')
      .values({
        id: 'gam_notOurs',
        home_team_id: 'tem_strangers',
        away_team_id: 'tem_theirs',
        start_at: new Date(now.getTime() + HOUR),
        created_at: now,
        updated_at: now
      })
      .execute()
    // And one of ours that was called off.
    await db
      .insertInto('games')
      .values({
        id: 'gam_cancelled',
        home_team_id: 'tem_ours',
        away_team_id: 'tem_theirs',
        start_at: new Date(now.getTime() + HOUR),
        status: 'cancelled',
        created_at: now,
        updated_at: now
      })
      .execute()
  }

  async function ask(
    path: string,
    token: string,
    method = 'GET'
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      }
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? {} : JSON.parse(text)
    }
  }

  it('offers ten, soonest first, reaching two hours back', async function () {
    if (db == null) this.skip()
    const answer = await ask(NEXT_TEN, COACH)
    expect(answer.status).equals(200)
    const events = answer.body as Array<{ gameId: string; startAt: string }>
    const ids = events.map(event => event.gameId)

    expect(ids.length, 'never more than a screenful').equals(10)
    expect(ids[0], 'the game that started an hour ago is still the one').equals(
      'gam_thisAfternoon'
    )
    expect(ids).does.not.contain('gam_longGone')
    expect(ids).does.not.contain('gam_notOurs')
    expect(ids).does.not.contain('gam_cancelled')
    // Ascending, so the next game to be played is the next row down.
    const times = events.map(event => Date.parse(event.startAt))
    expect([...times].sort((a, b) => a - b)).deep.equals(times)
  })

  it('lists a game once, however many cameras are on it', async function () {
    if (db == null) this.skip()
    // Four cameras on one game is the case this is for: joined to the games
    // table it listed the game four times and spent four of the ten on it.
    const now = new Date()
    for (let slot = 1; slot <= 3; slot += 1) {
      await db
        ?.insertInto('videos')
        .values({
          id: `vid_cam${slot}`,
          game_id: 'gam_third',
          kind: 'live',
          title: `A game — Camera ${slot}`,
          storage: 'local',
          status: 'processing',
          hidden: true,
          created_at: now,
          updated_at: now
        })
        .execute()
      await db
        ?.insertInto('live_streams')
        .values({
          id: `liv_cam${slot}`,
          game_id: 'gam_third',
          team_id: 'tem_ours',
          user_id: userIdOfGumbo(coachId),
          slot,
          key_hash: `hash_cam${slot}`,
          key_prefix: 'ts_cam',
          key_cipher: 'v1.a.b.c',
          state: slot === 2 ? 'publishing' : 'idle',
          opens_at: new Date(now.getTime() - HOUR),
          closes_at: new Date(now.getTime() + HOUR),
          video_id: `vid_cam${slot}`,
          created_at: now,
          updated_at: now
        })
        .execute()
    }

    const answer = await ask(NEXT_TEN, COACH)
    const events = answer.body as Array<{ gameId: string; liveState: string }>
    const appearances = events.filter(event => event.gameId === 'gam_third')
    expect(appearances.length, 'once, not once per camera').equals(1)
    // One camera publishing makes the game on, whatever the others are doing.
    expect(appearances[0].liveState).equals('publishing')
    expect(events.length, 'and the ten are still ten games').equals(10)
  })

  it('lists the next twenty and leaves out a twenty-first', async function () {
    if (db == null) this.skip()
    const now = new Date()
    for (let index = 0; index < 20; index += 1) {
      await db
        .insertInto('games')
        .values({
          id: `gam_extra_${index}`,
          home_team_id: 'tem_ours',
          away_team_id: 'tem_theirs',
          start_at: new Date(now.getTime() + (12 + index) * HOUR),
          created_at: now,
          updated_at: now
        })
        .execute()
    }
    const answer = await ask(NEXT_TWENTY, COACH)
    expect(answer.status).equals(200)
    const events = answer.body as Array<{ gameId: string; startAt: string }>
    const ids = events.map(event => event.gameId)
    expect(ids.length).equals(20)
    expect(ids[0]).equals('gam_thisAfternoon')
    expect(ids).does.not.contain('gam_longGone')
    expect(ids).does.not.contain('gam_cancelled')
    expect(ids).does.not.contain('gam_notOurs')
    expect(ids).does.not.contain('gam_extra_8')
    expect(ids).contains('gam_extra_7')
    const times = events.map(event => Date.parse(event.startAt))
    expect([...times].sort((a, b) => a - b)).deep.equals(times)
    const parent = await ask(NEXT_TWENTY, PARENT)
    expect(parent.status).equals(200)
    expect(parent.body).deep.equals([])
  })

  it('offers a parent nothing, however many games they can watch', async function () {
    if (db == null) this.skip()
    const answer = await ask(NEXT_TEN, PARENT)
    expect(answer.status).equals(200)
    expect(answer.body).deep.equals([])
  })

  it('answers none for a game whose every camera was deleted', async function () {
    if (db == null) this.skip()
    const now = new Date()
    const camera = {
      game_id: 'gam_sixth',
      team_id: 'tem_ours',
      user_id: userIdOfGumbo(coachId),
      slot: 1,
      key_prefix: 'ts_cam',
      key_cipher: 'v1.a.b.c',
      state: 'ended' as const,
      opens_at: now,
      closes_at: now,
      created_at: now,
      updated_at: now
    }
    await db
      .insertInto('live_streams')
      .values([
        {
          ...camera,
          id: 'liv_gone',
          key_hash: 'hash_gone',
          discarded_at: now
        },
        { ...camera, id: 'liv_kept', key_hash: 'hash_kept' }
      ])
      .execute()
    const liveState = async (): Promise<string | undefined> =>
      (
        (await ask(NEXT_TEN, COACH)).body as Array<{
          gameId: string
          liveState: string
        }>
      ).find(event => event.gameId === 'gam_sixth')?.liveState

    expect(await liveState()).equals('ended')
    await db
      .updateTable('live_streams')
      .set({ discarded_at: now })
      .where('id', '=', 'liv_kept')
      .execute()
    expect(await liveState()).equals('none')
  })

  it('names both sides, and carries no relay fields', async function () {
    if (db == null) this.skip()
    const answer = await ask(NEXT_TEN, COACH)
    const first = (answer.body as Array<Record<string, unknown>>)[0]
    expect(first.homeTeamName).equals('Ravens')
    expect(first.awayTeamName).equals('Titan')
    // `none` until somebody gives the game a stream.
    expect(first.liveState).equals('none')
    // No relay switch: nothing about an onward destination is listed.
    expect(
      Object.keys(first).filter(key => /Available$|Enabled$/.test(key))
    ).deep.equals([])
  })

  it('claims a game once, however many times it is asked for', async function () {
    if (db == null) this.skip()
    const first = await ask('/director/events/gam_next/claim', COACH, 'POST')
    expect(first.status).equals(200)
    const url = String((first.body as Record<string, unknown>).url)
    expect(url.startsWith('rtmp://live.example:1936/live/ts_')).equals(true)

    // Every redial claims again; the same game must give the same address.
    const again = await ask('/director/events/gam_next/claim', COACH, 'POST')
    expect((again.body as Record<string, unknown>).url).equals(url)

    const rows = await db
      ?.selectFrom('live_streams')
      .select(['id'])
      .where('game_id', '=', 'gam_next')
      .execute()
    expect(rows?.length).equals(1)
  })

  it('gives two Directors two keys for the same game', async function () {
    if (db == null) this.skip()
    // A second person who runs the team — a second iPad, on the other side of
    // the field. They are two cameras on one game now, not one publisher and
    // one refusal.
    const now = new Date()
    const secondId = mintUser()
    await insertFixtureUsers(db, {
      id: userIdOfGumbo(secondId),
      legacyId: legacyId(secondId),
      display_name: 'Second Coach',
      first_name: null,
      last_name: null,
      created_at: now,
      updated_at: now
    })
    await db
      ?.insertInto('auth_sessions')
      .values({
        id: 'ses_second',
        user_id: userIdOfGumbo(secondId),
        token_hash: hashToken(SECOND),
        expires_at: new Date(now.getTime() + HOUR),
        created_at: now
      })
      .execute()
    await db
      ?.insertInto('memberships')
      .values({
        id: 'mem_second',
        user_id: userIdOfGumbo(secondId),
        team_id: 'tem_ours',
        role: 'manager'
      })
      .execute()

    const first = await ask('/director/events/gam_later/claim', COACH, 'POST')
    const second = await ask('/director/events/gam_later/claim', SECOND, 'POST')
    expect(first.status).equals(200)
    expect(second.status).equals(200)
    const a = (first.body as Record<string, unknown>).url
    const b = (second.body as Record<string, unknown>).url
    expect(a).is.a('string')
    expect(b).does.not.equal(a)

    const rows = await db
      ?.selectFrom('live_streams')
      .select(['user_id as userId', 'slot'])
      .where('game_id', '=', 'gam_later')
      .orderBy('user_id', 'asc')
      .execute()
    expect(rows?.length).equals(2)
    // Each is that person's first camera, not somebody's second.
    expect(rows?.every(row => row.slot === 1)).equals(true)
  })

  it('will not let a parent claim a game', async function () {
    if (db == null) this.skip()
    const answer = await ask('/director/events/gam_later/claim', PARENT, 'POST')
    expect(answer.status).equals(404)
  })

  it('offers a videographer the team\u2019s games, and lets them claim one', async function () {
    if (db == null) this.skip()
    const listed = await ask(NEXT_TEN, FILMER)
    const events = listed.body as Array<{ gameId: string }>
    expect(events.length).equals(10)
    expect(events.map(event => event.gameId)).includes('gam_fourth')
    expect(events.map(event => event.gameId)).not.includes('gam_notOurs')
    const claimed = await ask(
      '/director/events/gam_fourth/claim',
      FILMER,
      'POST'
    )
    expect(claimed.status).equals(200)
  })

  it('offers a scorekeeper nothing to film, and refuses their claim', async function () {
    if (db == null) this.skip()
    const listed = await ask(NEXT_TEN, SCORER)
    expect(listed.body).deep.equals([])
    const claimed = await ask(
      '/director/events/gam_fifth/claim',
      SCORER,
      'POST'
    )
    expect(claimed.status).equals(404)
  })

  it('names the camera it claims, and a later name keeps the key', async function () {
    if (db == null) this.skip()
    const first = await claim('gam_sixth', { cameraName: '  Center Field  ' })
    expect(first.status).equals(200)
    const url = String(first.body.url)
    let stored = await cameraOf('gam_sixth')
    expect(stored.label).equals('Center Field')
    expect(stored.title.endsWith(' — Center Field')).equals(true)

    const again = await claim('gam_sixth', { cameraName: 'Left Field' })
    expect(String(again.body.url)).equals(url)
    stored = await cameraOf('gam_sixth')
    expect(stored.label).equals('Left Field')
    expect(stored.title.endsWith(' — Left Field')).equals(true)
    expect(stored.title.startsWith('Titan at Ravens — ')).equals(true)

    const blank = await claim('gam_sixth', { cameraName: '' })
    expect(String(blank.body.url)).equals(url)
    stored = await cameraOf('gam_sixth')
    expect(stored.label).equals('Left Field')
    expect(stored.title.endsWith(' — Left Field')).equals(true)

    const empty = await claim('gam_sixth')
    expect(String(empty.body.url)).equals(url)
    stored = await cameraOf('gam_sixth')
    expect(stored.label).equals('Left Field')
    expect(stored.title.endsWith(' — Left Field')).equals(true)
  })

  it('refuses a camera name that is too long or contains the angle separator', async function () {
    if (db == null) this.skip()
    const tooLong = 'C'.repeat(81)
    const refused = await claim('gam_seventh', { cameraName: tooLong })
    expect(refused.status).equals(400)
    expect(String(refused.body.message)).equals(
      'A camera name can be at most 80 characters.'
    )
    expect(await cameraCount('gam_seventh')).equals(0)

    const made = await claim('gam_seventh', { cameraName: 'Center Field' })
    expect(made.status).equals(200)

    const stillLong = await claim('gam_seventh', { cameraName: ` ${tooLong} ` })
    expect(stillLong.status).equals(400)
    expect(String(stillLong.body.message)).equals(
      'A camera name can be at most 80 characters.'
    )
    let stored = await cameraOf('gam_seventh')
    expect(stored.label).equals('Center Field')
    expect(stored.title.endsWith(' — Center Field')).equals(true)

    const split = await claim('gam_seventh', { cameraName: 'Home — Plate' })
    expect(split.status).equals(400)
    expect(String(split.body.message)).equals(
      'A camera name cannot contain " — ".'
    )
    stored = await cameraOf('gam_seventh')
    expect(stored.label).equals('Center Field')
    expect(stored.title.endsWith(' — Center Field')).equals(true)
  })

  it('labels a new stream TS Director when the claim sends no name', async function () {
    if (db == null) this.skip()
    const first = await claim('gam_eighth', { cameraName: '   ' })
    expect(first.status).equals(200)
    let stored = await cameraOf('gam_eighth')
    expect(stored.label).equals('TS Director')
    expect(stored.title.endsWith(' — TS Director')).equals(true)

    const again = await claim('gam_eighth')
    expect(again.status).equals(200)
    stored = await cameraOf('gam_eighth')
    expect(stored.label).equals('TS Director')
    expect(stored.title.endsWith(' — TS Director')).equals(true)
  })

  it('stores a camera name of exactly 80 characters', async function () {
    if (db == null) this.skip()
    const name = 'N'.repeat(80)
    const made = await claim('gam_ninth', { cameraName: ` ${name} ` })
    expect(made.status).equals(200)
    const stored = await cameraOf('gam_ninth')
    expect(stored.label).equals(name)
    expect(stored.title.endsWith(` — ${name}`)).equals(true)
  })

  it('refuses a camera name containing the separator before a stream exists', async function () {
    if (db == null) this.skip()
    const refused = await claim('gam_tenth', { cameraName: 'A — B' })
    expect(refused.status).equals(400)
    expect(String(refused.body.message)).equals(
      'A camera name cannot contain " — ".'
    )
    expect(await cameraCount('gam_tenth')).equals(0)
  })

  async function claim(
    gameId: string,
    body?: unknown
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}/director/events/${gameId}/claim`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${COACH}`,
        'content-type': 'application/json'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    }
  }

  async function cameraOf(
    gameId: string
  ): Promise<{ label: string | null; title: string }> {
    const row = await db
      ?.selectFrom('live_streams')
      .innerJoin('videos', 'videos.id', 'live_streams.video_id')
      .select(['live_streams.label as label', 'videos.title as title'])
      .where('live_streams.game_id', '=', gameId)
      .executeTakeFirst()
    if (row == null) throw new Error(`no camera on ${gameId}`)
    return { label: row.label, title: row.title }
  }

  async function cameraCount(gameId: string): Promise<number> {
    const rows = await db
      ?.selectFrom('live_streams')
      .select(['id'])
      .where('game_id', '=', gameId)
      .execute()
    return rows?.length ?? 0
  }
})
