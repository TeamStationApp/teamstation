import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { directorRoutes } from './director'

/**
 * The list GS Director shows, which Paul specified to the row.
 *
 * Soonest first, reaching two hours backwards — a game called for one o'clock
 * that somebody starts filming at ten past three is still the game they mean —
 * and never more than ten, because a longer list is a worse one. Of the games
 * the account **runs**, not the games it may watch: a parent's forty watchable
 * games would bury the one they are holding a camera for.
 */
const adminUrl = testDatabaseUrl
const scratchName = `gamestation_director_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const COACH = 'tok_coach_00000000000000000000000'
const PARENT = 'tok_parent_0000000000000000000000'
const SECOND = 'tok_second_0000000000000000000000'
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

describe('what GS Director is offered', function () {
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
    app.use(
      '/api/v1',
      directorRoutes(db, {
        live: {
          enabled: true,
          bindHost: '0.0.0.0',
          port: 1936,
          app: 'live',
          segmentSeconds: 4,
          closeAfterHours: 6,
          freeDiskFloorGb: 10
        },
        sessionSecret: 'k'.repeat(32),
        host: 'live.example'
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
      [parentId, 'Parent']
    ] as Array<[number, string]>) {
      await db
        .insertInto('users')
        .values({
          id,
          legacyId: legacyId(id),
          display_name: name,
          first_name: null,
          last_name: null,
          created_at: now,
          updated_at: now
        })
        .execute()
    }
    for (const [id, user, token] of [
      ['ses_coach', coachId, COACH],
      ['ses_parent', parentId, PARENT]
    ] as Array<[string, number, string]>) {
      await db
        .insertInto('auth_sessions')
        .values({
          id,
          user_id: user,
          token_hash: hashToken(token),
          expires_at: new Date(now.getTime() + HOUR),
          created_at: now
        })
        .execute()
    }
    for (const [id, name] of [
      ['tem_ours', 'Rangers'],
      ['tem_theirs', 'Trosky'],
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
        user_id: coachId,
        team_id: 'tem_ours',
        role: 'manager'
      })
      .execute()
    await db
      .insertInto('memberships')
      .values({
        id: 'mem_parent',
        user_id: parentId,
        team_id: 'tem_ours',
        role: 'member'
      })
      .execute()

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
    const answer = await ask('/director/events', COACH)
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
          user_id: coachId,
          slot,
          key_hash: `hash_cam${slot}`,
          key_prefix: 'gs_cam',
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

    const answer = await ask('/director/events', COACH)
    const events = answer.body as Array<{ gameId: string; liveState: string }>
    const appearances = events.filter(event => event.gameId === 'gam_third')
    expect(appearances.length, 'once, not once per camera').equals(1)
    // One camera publishing makes the game on, whatever the others are doing.
    expect(appearances[0].liveState).equals('publishing')
    expect(events.length, 'and the ten are still ten games').equals(10)
  })

  it('offers a parent nothing, however many games they can watch', async function () {
    if (db == null) this.skip()
    const answer = await ask('/director/events', PARENT)
    expect(answer.status).equals(200)
    expect(answer.body).deep.equals([])
  })

  it('names both sides, and carries no relay fields', async function () {
    if (db == null) this.skip()
    const answer = await ask('/director/events', COACH)
    const first = (answer.body as Array<Record<string, unknown>>)[0]
    expect(first.homeTeamName).equals('Rangers')
    expect(first.awayTeamName).equals('Trosky')
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
    expect(url.startsWith('rtmp://live.example:1936/live/gs_')).equals(true)

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
    await db
      ?.insertInto('users')
      .values({
        id: secondId,
        legacyId: legacyId(secondId),
        display_name: 'Second Coach',
        first_name: null,
        last_name: null,
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      ?.insertInto('auth_sessions')
      .values({
        id: 'ses_second',
        user_id: secondId,
        token_hash: hashToken(SECOND),
        expires_at: new Date(now.getTime() + HOUR),
        created_at: now
      })
      .execute()
    await db
      ?.insertInto('memberships')
      .values({
        id: 'mem_second',
        user_id: secondId,
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
})
