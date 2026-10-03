import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { type Kysely, sql } from 'kysely'
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
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { scheduleRoutes } from './schedule'

/**
 * Who may write a team's schedule through POST /teams/:teamId/games: an admin
 * of the team, of its season or of that season's league, or a site admin.
 */

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_schedule_route_${Date.now()}`
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
  'flagged',
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
  const fieldGame = makeId('game')
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
          user_id: user('flagged'),
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
      .insertInto('scope_roles')
      .values(
        (
          [
            ['teamRole', 'team', hawks],
            ['seasonAdmin', 'season', spring],
            ['otherSeasonAdmin', 'season', fall],
            ['leagueAdmin', 'league', league]
          ] as const
        ).map(([person, scopeType, scopeId]) => ({
          id: makeId('scopeRole'),
          user_id: user(person),
          scope_type: scopeType,
          scope_id: scopeId
        }))
      )
      .execute()
    // Every flag, on the team and everything above it: none of them is the
    // right to schedule.
    await db
      .insertInto('scope_roles')
      .values(
        (
          ['coach', 'scorekeeper', 'songkeeper', 'videographer'] as const
        ).flatMap(role =>
          (
            [
              ['team', hawks],
              ['season', spring],
              ['league', league]
            ] as const
          ).map(([scopeType, scopeId]) => ({
            id: makeId('scopeRole'),
            user_id: user('flagged'),
            scope_type: scopeType,
            scope_id: scopeId,
            role
          }))
        )
      )
      .execute()

    // Gulls at home to the Hawks: the Hawks' admins run the away side.
    await db
      .insertInto('games')
      .values({
        id: fieldGame,
        home_team_id: gulls,
        away_team_id: hawks,
        season_id: spring,
        start_at: new Date('2026-04-20T17:00:00Z')
      })
      .execute()

    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use(withAudit(db))
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
      opponent: { name: 'Dragons' },
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

  it('answers 403 to a member, a parent and somebody holding every flag', async function () {
    for (const person of ['member', 'parent', 'flagged'] as const) {
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

  const opponentKey = (id: string): object => ({
    system: 'otherLeague',
    kind: 'opponent',
    id
  })
  const awayTeamOf = async (gameId: string): Promise<string> =>
    (
      await db!
        .selectFrom('games')
        .select(['away_team_id'])
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
    ).away_team_id
  const holdersOf = async (
    id: string
  ): Promise<Array<{ entity_type: string; entity_id: string }>> =>
    await db!
      .selectFrom('external_ids')
      .select(['entity_type', 'entity_id'])
      .where('system', '=', 'otherLeague')
      .where('kind', '=', 'opponent')
      .where('external_id', '=', id)
      .execute()

  it('records an opponent’s id on the external team it makes, and finds that team by it again', async function () {
    const first = await schedule('owner', {
      games: [
        {
          ...springRow(),
          opponent: { name: 'Rattlers', externalId: opponentKey('opp-1') }
        }
      ]
    })
    expect(first.body.results[0].result).equals('created')
    const rattlers = await awayTeamOf(first.body.results[0].gameId)
    expect(await holdersOf('opp-1')).deep.equals([
      { entity_type: 'team', entity_id: rattlers }
    ])

    // Another name, the same id: the same team, and no new one.
    const second = await schedule('owner', {
      games: [
        {
          ...springRow(),
          opponent: { name: 'Sidewinders', externalId: opponentKey('opp-1') }
        }
      ]
    })
    expect(second.body.results[0].result).equals('created')
    expect(await awayTeamOf(second.body.results[0].gameId)).equals(rattlers)
    const named = await db!
      .selectFrom('teams')
      .select('id')
      .where('name', '=', 'Sidewinders')
      .execute()
    expect(named).deep.equals([])
  })

  it('plays a full team holding the id, and never records one on a full team', async function () {
    await db!
      .insertInto('external_ids')
      .values({
        id: makeId('externalId'),
        entity_type: 'team',
        entity_id: gulls,
        system: 'otherLeague',
        kind: 'opponent',
        external_id: 'gulls-1'
      })
      .execute()
    const answer = await schedule('owner', {
      games: [
        {
          ...springRow(),
          opponent: { name: 'Somebody', externalId: opponentKey('gulls-1') }
        },
        // The name finds the Gulls, who are full: the id stays unrecorded.
        {
          ...springRow(),
          opponent: { name: 'Gulls', externalId: opponentKey('gulls-2') }
        }
      ]
    })
    expect(answer.body.results[0].result).equals('created')
    expect(await awayTeamOf(answer.body.results[0].gameId)).equals(gulls)
    expect(answer.body.results[1].result).equals('created')
    expect(await awayTeamOf(answer.body.results[1].gameId)).equals(gulls)
    expect(await holdersOf('gulls-2')).deep.equals([])

    await db!
      .insertInto('external_ids')
      .values({
        id: makeId('externalId'),
        entity_type: 'team',
        entity_id: hawks,
        system: 'otherLeague',
        kind: 'opponent',
        external_id: 'hawks-1'
      })
      .execute()
    // An id on the team itself is no opponent.
    const self = await schedule('owner', {
      games: [
        {
          ...springRow(),
          opponent: { name: 'Mirror', externalId: opponentKey('hawks-1') }
        }
      ]
    })
    expect(self.body.results[0].error).deep.equals({
      code: 'conflict',
      message: 'otherLeague hawks-1 is Hawks itself'
    })
  })

  it('leaves an id something else holds where it is', async function () {
    await db!
      .insertInto('external_ids')
      .values({
        id: makeId('externalId'),
        entity_type: 'game',
        entity_id: fieldGame,
        system: 'otherLeague',
        kind: 'opponent',
        external_id: 'held-1'
      })
      .execute()
    const answer = await schedule('owner', {
      games: [
        {
          ...springRow(),
          opponent: { name: 'Strangers', externalId: opponentKey('held-1') }
        }
      ]
    })
    expect(answer.body.results[0].result).equals('created')
    const strangers = await db!
      .selectFrom('teams')
      .select(['id', 'kind'])
      .where('name', '=', 'Strangers')
      .executeTakeFirstOrThrow()
    expect(strangers.kind).equals('external')
    expect(await awayTeamOf(answer.body.results[0].gameId)).equals(strangers.id)
    expect(await holdersOf('held-1')).deep.equals([
      { entity_type: 'game', entity_id: fieldGame }
    ])
  })

  it('records the id on a matched game’s external opponent its name finds, and changes nothing else', async function () {
    const external = { ...springRow(), opponent: { name: 'Matchers' } }
    const full = { ...springRow(), opponent: { teamId: gulls } }
    const gameKey = (id: string): object => ({ system: 'otherLeague', id })
    const made = await schedule('owner', {
      games: [
        { ...external, externalId: gameKey('match-1') },
        { ...full, externalId: gameKey('match-2') }
      ]
    })
    const matched = made.body.results[0].gameId
    const matchers = await awayTeamOf(matched)

    const again = await schedule('owner', {
      games: [
        {
          ...external,
          opponent: { name: 'matchers', externalId: opponentKey('match-o1') },
          externalId: gameKey('match-1')
        },
        {
          ...full,
          opponent: { name: 'Gulls', externalId: opponentKey('match-o2') },
          externalId: gameKey('match-2')
        }
      ]
    })
    expect(again.body.results.map((r: any) => r.result)).deep.equals([
      'unchanged',
      'unchanged'
    ])
    expect(await awayTeamOf(matched)).equals(matchers)
    expect(await holdersOf('match-o1')).deep.equals([
      { entity_type: 'team', entity_id: matchers }
    ])
    expect(await holdersOf('match-o2')).deep.equals([])
  })

  it('records nothing on a matched game’s opponent the row’s name does not find', async function () {
    const held = {
      ...springRow(),
      opponent: { name: 'Placeholder X' },
      externalId: { system: 'otherLeague', id: 'placeholder-1' }
    }
    const made = await schedule('owner', { games: [held] })
    const placeholder = await awayTeamOf(made.body.results[0].gameId)
    const again = await schedule('owner', {
      games: [
        {
          ...held,
          opponent: { name: 'Rattlers', externalId: opponentKey('real-1') }
        }
      ]
    })
    expect(again.body.results[0].result).equals('unchanged')
    expect(await awayTeamOf(made.body.results[0].gameId)).equals(placeholder)
    expect(await holdersOf('real-1')).deep.equals([])

    // A new game against the real opponent takes the id to it.
    const fresh = await schedule('owner', {
      games: [
        {
          ...springRow(),
          opponent: { name: 'Rattlers', externalId: opponentKey('real-1') }
        }
      ]
    })
    const rattlers = await db!
      .selectFrom('teams')
      .select(['id', 'kind'])
      .where('name', '=', 'Rattlers')
      .executeTakeFirstOrThrow()
    expect(rattlers.kind).equals('external')
    expect(await awayTeamOf(fresh.body.results[0].gameId)).equals(rattlers.id)
    expect(await holdersOf('real-1')).deep.equals([
      { entity_type: 'team', entity_id: rattlers.id }
    ])
  })

  it('takes over an id whose team no longer exists', async function () {
    const orphan = makeId('externalId')
    await db!
      .insertInto('external_ids')
      .values({
        id: orphan,
        entity_type: 'team',
        entity_id: makeId('team'),
        system: 'otherLeague',
        kind: 'opponent',
        external_id: 'orphan-1'
      })
      .execute()
    const answer = await schedule('owner', {
      games: [
        {
          ...springRow(),
          opponent: { name: 'Phoenix', externalId: opponentKey('orphan-1') }
        }
      ]
    })
    expect(answer.body.results[0].result).equals('created')
    const phoenix = await awayTeamOf(answer.body.results[0].gameId)
    const rows = await db!
      .selectFrom('external_ids')
      .select(['id', 'entity_type', 'entity_id'])
      .where('external_id', '=', 'orphan-1')
      .execute()
    expect(rows).deep.equals([
      { id: orphan, entity_type: 'team', entity_id: phoenix }
    ])
  })

  it('refuses a row whose opponent id is malformed', async function () {
    const answer = await schedule('owner', {
      games: [
        { system: 'Other League', kind: 'opponent', id: 'x' },
        { system: 'otherLeague', kind: '', id: 'x' },
        { system: 'otherLeague', kind: 'opponent', id: '' }
      ].map(externalId => ({
        ...springRow(),
        opponent: { name: 'Bad Ids', externalId }
      }))
    })
    expect(answer.status).equals(200)
    expect(
      answer.body.results.map((r: any) => [r.error.code, r.error.message])
    ).deep.equals([
      [
        'invalid',
        'opponent.externalId.system must match ^[a-z][a-zA-Z0-9]{0,31}$'
      ],
      ['invalid', 'opponent.externalId.kind must be a non-empty string'],
      ['invalid', 'opponent.externalId.id must be a non-empty string']
    ])
  })

  async function setField(
    person: Person | null,
    body: unknown,
    gameId = fieldGame
  ): Promise<{ status: number; body: any }> {
    const response = await fetch(`${base}/games/${gameId}/field`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(person == null ? {} : { authorization: `Bearer ${token(person)}` })
      },
      body: JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  const storedFence = async (): Promise<number | null> =>
    (
      await db!
        .selectFrom('games')
        .select(['fence_distance_ft'])
        .where('id', '=', fieldGame)
        .executeTakeFirstOrThrow()
    ).fence_distance_ft

  it('sets and clears a game’s fence for each kind of admin, and audits it', async function () {
    for (const [index, person] of (
      [
        'site',
        'owner',
        'manager',
        'teamRole',
        'seasonAdmin',
        'leagueAdmin'
      ] as const
    ).entries()) {
      const feet = 180 + index
      const answer = await setField(person, { fenceDistanceFt: feet })
      expect(answer.status, person).equals(200)
      expect(answer.body).deep.equals({
        gameId: fieldGame,
        fenceDistanceFt: feet,
        resolvedFenceDistanceFt: feet
      })
      expect(await storedFence()).equals(feet)
    }
    // Null hands the fence back to the season, then the league, then 200.
    await db!
      .updateTable('leagues')
      .set({ fence_distance_ft: 225 })
      .where('id', '=', league)
      .execute()
    const cleared = await setField('seasonAdmin', { fenceDistanceFt: null })
    expect(cleared.body).deep.equals({
      gameId: fieldGame,
      fenceDistanceFt: null,
      resolvedFenceDistanceFt: 225
    })
    expect(await storedFence()).equals(null)

    let audited: Array<{ before: unknown; after: unknown }> = []
    for (let tries = 0; tries < 50 && audited.length < 7; tries++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      audited = await db!
        .selectFrom('audit_log')
        .select(['before', 'after'])
        .where('entity_type', '=', 'game')
        .where('entity_id', '=', fieldGame)
        .orderBy('at')
        .execute()
    }
    expect(audited).length(7)
    expect(audited.at(-1)).deep.equals({
      before: { fenceDistanceFt: 185 },
      after: { fenceDistanceFt: null }
    })
  })

  it('refuses a game’s fence to anybody who does not run the game', async function () {
    expect((await setField(null, { fenceDistanceFt: 200 })).status).equals(401)
    expect(
      (await setField('site', { fenceDistanceFt: 200 }, makeId('game'))).status
    ).equals(404)
    // Another season's admin sees the Hawks' games there, not this one.
    for (const person of ['stranger', 'otherSeasonAdmin'] as const)
      expect(
        (await setField(person, { fenceDistanceFt: 200 })).status,
        person
      ).equals(404)
    for (const person of ['member', 'parent'] as const) {
      const answer = await setField(person, { fenceDistanceFt: 200 })
      expect(answer.status, person).equals(403)
      expect(answer.body.code, person).equals('forbidden')
    }
    for (const body of [
      {},
      { fenceDistanceFt: 0 },
      { fenceDistanceFt: 601 },
      { fenceDistanceFt: 200.5 },
      { fenceDistanceFt: '200' },
      [200]
    ]) {
      expect(
        (await setField('owner', body)).status,
        JSON.stringify(body)
      ).equals(400)
    }
    expect(await storedFence()).equals(null)
  })
  it('refuses a game’s fence once the game has plays, whatever its status', async function () {
    const setStatus = async (
      status: 'scheduled' | 'inProgress' | 'final' | 'cancelled'
    ): Promise<void> => {
      await db!
        .updateTable('games')
        .set({ status })
        .where('id', '=', fieldGame)
        .execute()
    }
    // Under way with nothing posted yet, its fence can still move.
    await setStatus('inProgress')
    expect((await setField('site', { fenceDistanceFt: null })).status).equals(
      200
    )
    const play = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'stolen_base', awayScore: null, homeScore: null }
    }
    await sql`insert into events (id, "gameId", "battingTeamId", gumbo)
      values (${makeId('event')}, ${fieldGame}, ${hawks}, ${JSON.stringify(play)}::jsonb)`.execute(
      db!
    )
    for (const status of [
      'scheduled',
      'inProgress',
      'final',
      'cancelled'
    ] as const) {
      await setStatus(status)
      const answer = await setField('site', { fenceDistanceFt: 250 })
      expect(answer.status, status).equals(409)
      expect(answer.body.code, status).equals('conflict')
      expect(answer.body.message, status).equals(
        'The fence is fixed once a game has plays'
      )
      expect(await storedFence(), status).equals(null)
    }
    // Who may not set it at all still hears so first.
    expect((await setField('member', { fenceDistanceFt: 250 })).status).equals(
      403
    )
    await db!.deleteFrom('events').where('gameId', '=', fieldGame).execute()
    await setStatus('scheduled')

    // A first post that holds the game while the fence is set wins: the
    // fence is refused once it commits.
    let answer: Promise<{ status: number }> | undefined
    await db!.transaction().execute(async trx => {
      await trx
        .selectFrom('games')
        .select('id')
        .where('id', '=', fieldGame)
        .forUpdate()
        .execute()
      await sql`insert into events (id, "gameId", "battingTeamId", gumbo)
        values (${makeId('event')}, ${fieldGame}, ${hawks}, ${JSON.stringify(play)}::jsonb)`.execute(
        trx
      )
      answer = setField('site', { fenceDistanceFt: 250 })
      await new Promise(resolve => setTimeout(resolve, 200))
    })
    expect((await answer!).status).equals(409)
    expect(await storedFence()).equals(null)
    await db!.deleteFrom('events').where('gameId', '=', fieldGame).execute()
    expect((await setField('site', { fenceDistanceFt: null })).status).equals(
      200
    )
  })
})
