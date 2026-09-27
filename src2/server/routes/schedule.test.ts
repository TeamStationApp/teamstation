import type { AddressInfo } from 'node:net'

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
import { jsonBody } from '../jsonBody'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { scheduleRoutes } from './schedule'

/**
 * Who may write a team's schedule through POST /teams/:teamId/games: an admin
 * of the team, of its season or of that season's league, or a site admin.
 */

const adminUrl = testDatabaseUrl
const scratchName = `gamestation_schedule_route_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const PEOPLE = [
  'site',
  'owner',
  'manager',
  'teamRole',
  'member',
  'parent',
  'seasonAdmin',
  'otherSeasonAdmin',
  'leagueAdmin',
  'stranger'
] as const
type Person = (typeof PEOPLE)[number]

const MESSAGE =
  'Only an admin of this team, its season or its league may schedule its games'

describe('scheduling a team’s games over HTTP', function () {
  this.timeout(60000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const league = makeId('league')
  const spring = makeId('season')
  const fall = makeId('season')
  const hawks = makeId('team')
  const gulls = makeId('team')
  const outsiders = makeId('team')
  const users = new Map<Person, number>()
  const token = (person: Person): string => `tok_schedule_${person}_0000000000`

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    const now = new Date()
    for (const person of PEOPLE) {
      const made = mintUserId(id => [...users.values()].includes(id))
      users.set(person, made.userId)
      await db
        .insertInto('users')
        .values({
          id: made.userId,
          legacyId: made.legacyId,
          display_name: person,
          is_admin: person === 'site',
          created_at: now,
          updated_at: now
        })
        .execute()
      await db
        .insertInto('auth_sessions')
        .values({
          id: makeId('authSession'),
          user_id: made.userId,
          token_hash: hashToken(token(person)),
          created_at: now,
          expires_at: new Date(now.getTime() + 3_600_000)
        })
        .execute()
    }
    const user = (person: Person): number => users.get(person) ?? 0

    await db
      .insertInto('leagues')
      .values({ id: league, name: 'League' })
      .execute()
    await db
      .insertInto('seasons')
      .values([
        {
          id: spring,
          league_id: league,
          name: 'Spring 2026',
          year: 2026,
          starts_on: '2026-03-01',
          ends_on: '2026-06-30'
        },
        {
          id: fall,
          name: 'Fall 2026',
          year: 2026,
          starts_on: '2026-09-01',
          ends_on: '2026-11-30'
        }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: hawks, name: 'Hawks' },
        { id: gulls, name: 'Gulls' },
        { id: outsiders, name: 'Outsiders', kind: 'external' }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values([
        { season_id: spring, team_id: hawks },
        { season_id: fall, team_id: hawks },
        { season_id: spring, team_id: gulls }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: user('owner'),
          team_id: hawks,
          role: 'owner'
        },
        {
          id: makeId('membership'),
          user_id: user('manager'),
          team_id: hawks,
          role: 'manager'
        },
        {
          id: makeId('membership'),
          user_id: user('member'),
          team_id: hawks,
          role: 'member'
        },
        {
          id: makeId('membership'),
          user_id: user('parent'),
          team_id: hawks,
          role: 'member',
          is_spectator: true
        }
      ])
      .execute()
    await db
      .insertInto('admin_roles')
      .values(
        (
          [
            ['teamRole', 'team', hawks],
            ['seasonAdmin', 'season', spring],
            ['otherSeasonAdmin', 'season', fall],
            ['leagueAdmin', 'league', league]
          ] as const
        ).map(([person, scopeType, scopeId]) => ({
          id: makeId('adminRole'),
          user_id: user(person),
          scope_type: scopeType,
          scope_id: scopeId
        }))
      )
      .execute()

    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use('/api/v1', scheduleRoutes(db))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(
        `drop database if exists ${scratchName} with (force)`
      )
      await adminPool.end()
    }
  })

  let minute = 0
  const springRow = (): object => {
    minute += 1
    return {
      opponent: { name: 'Diablos' },
      side: 'home',
      startAt: new Date(Date.UTC(2026, 3, 1, 17, minute)).toISOString()
    }
  }
  const fallRow = (): object => ({
    ...springRow(),
    startAt: new Date(Date.UTC(2026, 9, 1, 17, minute)).toISOString()
  })

  async function schedule(
    person: Person | null,
    body: unknown,
    teamId = hawks
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}/teams/${teamId}/games`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(person == null ? {} : { authorization: `Bearer ${token(person)}` })
      },
      body: JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }

  it('answers 401 without a session', async function () {
    expect((await schedule(null, { games: [springRow()] })).status).equals(401)
  })

  it('answers 404 for a missing team and one the caller cannot see', async function () {
    expect(
      (await schedule('site', { games: [springRow()] }, makeId('team'))).status
    ).equals(404)
    expect(
      (await schedule('stranger', { games: [springRow()] })).status
    ).equals(404)
  })

  it('answers 403 to a member and a parent', async function () {
    for (const person of ['member', 'parent'] as const) {
      const answer = await schedule(person, { games: [springRow()] })
      expect(answer.status, person).equals(403)
      expect(answer.body.message).equals(MESSAGE)
    }
  })

  it('lets every kind of admin schedule', async function () {
    for (const person of [
      'site',
      'owner',
      'manager',
      'teamRole',
      'seasonAdmin',
      'leagueAdmin'
    ] as const) {
      const answer = await schedule(person, { games: [springRow()] })
      expect(answer.status, person).equals(200)
      expect(answer.body.results[0].result, person).equals('created')
    }
  })

  it('refuses a row into a season a season admin does not administer', async function () {
    const answer = await schedule('otherSeasonAdmin', {
      games: [springRow(), fallRow()]
    })
    expect(answer.status).equals(200)
    expect(answer.body.results[0].result).equals('error')
    expect(answer.body.results[0].error.code).equals('forbidden')
    expect(answer.body.results[0].error.message).includes('Spring 2026')
    expect(answer.body.results[1].result).equals('created')
  })

  it('refuses a league admin a row into a season outside the league', async function () {
    const answer = await schedule('leagueAdmin', {
      games: [{ ...springRow(), seasonId: fall }, springRow()]
    })
    expect(answer.body.results[0].error.code).equals('forbidden')
    expect(answer.body.results[1].result).equals('created')
  })

  it('answers 400 for an external team and a malformed body', async function () {
    expect(
      (await schedule('site', { games: [springRow()] }, outsiders)).status
    ).equals(400)
    for (const body of [
      {},
      { games: [] },
      { games: Array(201).fill(springRow()) },
      'x'
    ]) {
      expect(
        (await schedule('owner', body)).status,
        JSON.stringify(body).slice(0, 40)
      ).equals(400)
    }
  })

  it('answers a mixed batch row by row, as the database holds it', async function () {
    const answer = await schedule('manager', {
      games: [
        { ...springRow(), externalId: { system: 'otherLeague', id: 'mix-1' } },
        { ...springRow(), startAt: '2026-04-01 17:00' },
        { ...springRow(), startAt: '2027-04-01T17:00:00Z' }
      ]
    })
    expect(answer.status).equals(200)
    expect(answer.body.results.map((r: any) => r.result)).deep.equals([
      'created',
      'error',
      'error'
    ])
    expect(answer.body.results[1].error.code).equals('invalid')
    expect(answer.body.results[2].error.code).equals('noSeason')
    expect(answer.body.counts).deep.equals({
      created: 1,
      updated: 0,
      unchanged: 0,
      error: 2
    })
    const held = await db!
      .selectFrom('external_ids')
      .select(['entity_id'])
      .where('external_id', '=', 'mix-1')
      .executeTakeFirstOrThrow()
    expect(held.entity_id).equals(answer.body.results[0].gameId)
  })
})
