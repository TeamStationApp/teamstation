import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { storedGuests } from '../../common/guests'
import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../common/gumboPlay'
import { makeId } from '../../common/ids'
import type { ScoringAction } from '../../common/scoring/actions'
import { newSetup } from '../../common/scoring/lineup'
import { ScoringSession } from '../../common/scoring/session'
import { teamsOfRow } from '../../common/teamLists'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { replaceGameEvents } from '../events/eventWrite'
import { postGamePlays, readPlays } from '../events/postPlays'
import { lineupsAnswer, storedLineupsDigest } from '../events/teamLineups'
import { jsonBody } from '../jsonBody'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { drain } from '../statsBuilder/builder'
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
      await insertFixtureUsers(db, {
        id: userIdOfGumbo(made.userId),
        legacyId: made.legacyId,
        display_name: person,
        is_admin: person === 'site',
        login_enabled: true,
        created_at: now,
        updated_at: now
      })
      await db
        .insertInto('auth_sessions')
        .values({
          id: makeId('authSession'),
          user_id: userIdOfGumbo(made.userId),
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
        { id: hawks, name: 'Hawks', league_id: league },
        { id: gulls, name: 'Gulls', league_id: league },
        {
          id: outsiders,
          name: 'Outsiders',
          kind: 'external',
          custodian_type: 'season',
          custodian_id: spring
        }
      ])
      .execute()
    await db
      .insertInto('season_team_parents')
      .values([
        { season_id: spring, team_id: hawks },
        { season_id: spring, team_id: gulls }
      ])
      .execute()
    // These explicit parents model an already completed ownership cutover.
    await db
      .insertInto('system_settings')
      .values({ key: 'creation.hierarchyReady', value: true })
      .onConflict(oc => oc.column('key').doUpdateSet({ value: true }))
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
          user_id: userIdOfGumbo(user('owner')),
          team_id: hawks,
          role: 'owner'
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(user('manager')),
          team_id: hawks,
          role: 'manager'
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(user('member')),
          team_id: hawks,
          role: 'member'
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(user('flagged')),
          team_id: hawks,
          role: 'member'
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(user('parent')),
          team_id: hawks,
          role: 'member'
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
            ['leagueAdmin', 'league', league],
            ['owner', 'season', spring],
            ['manager', 'season', spring],
            ['teamRole', 'season', spring],
            ['otherSeasonAdmin', 'team', hawks]
          ] as const
        ).map(([person, scopeType, scopeId]) => ({
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(user(person)),
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
            user_id: userIdOfGumbo(user('flagged')),
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
    app.use(
      '/api/v1',
      scheduleRoutes(db, { onGameWritten: gameId => written.push(gameId) })
    )
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

  /** The games the routes told the scoreboard about, in order. */
  const written: string[] = []
  let minute = 0
  const springRow = (): object => {
    minute += 1
    return {
      opponent: { name: 'Dunlins' },
      side: 'home',
      seasonId: spring,
      startAt: new Date(Date.UTC(2026, 3, 1, 17, minute)).toISOString()
    }
  }
  const fallRow = (): object => ({
    ...springRow(),
    opponent: { name: 'Demo Autumn Opponent' },
    seasonId: fall,
    startAt: new Date(Date.UTC(2026, 9, 1, 17, minute)).toISOString()
  })

  async function schedule(
    person: Person | null,
    body: unknown,
    teamId = hawks
  ): Promise<{ status: number; body: any }> {
    await db!
      .updateTable('teams')
      .set({ custodian_type: 'season', custodian_id: spring })
      .where('kind', '=', 'external')
      .where('custodian_id', 'is', null)
      .execute()
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

  it('publishes when the current administrator represents the host and both teams', async function () {
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
        { ...springRow(), seasonId: undefined, startAt: '2027-04-01T17:00:00Z' }
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

  it('gives a matched game the opponent its row’s name finds, and that team the id, never the placeholder', async function () {
    const held = {
      ...springRow(),
      opponent: { name: 'Placeholder X' },
      externalId: { system: 'otherLeague', id: 'placeholder-1' }
    }
    const made = await schedule('owner', { games: [held] })
    const gameId: string = made.body.results[0].gameId
    const placeholder = await awayTeamOf(gameId)
    const again = await schedule('owner', {
      games: [
        {
          ...held,
          opponent: { name: 'Rattlers', externalId: opponentKey('real-1') }
        }
      ]
    })
    expect(again.body.results[0].result).equals('updated')
    const rattlers = await db!
      .selectFrom('teams')
      .select(['id', 'kind'])
      .where('name', '=', 'Rattlers')
      .executeTakeFirstOrThrow()
    expect(rattlers.kind).equals('external')
    expect(await awayTeamOf(gameId)).equals(rattlers.id)
    expect(await holdersOf('real-1')).deep.equals([
      { entity_type: 'team', entity_id: rattlers.id }
    ])
    expect(placeholder).not.equals(rattlers.id)

    // A new game against the real opponent finds it by the id.
    const fresh = await schedule('owner', {
      games: [
        {
          ...springRow(),
          opponent: { name: 'Rattlers', externalId: opponentKey('real-1') }
        }
      ]
    })
    expect(await awayTeamOf(fresh.body.results[0].gameId)).equals(rattlers.id)
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

  const sidesOf = async (
    gameId: string
  ): Promise<{
    home_team_id: string
    away_team_id: string
    home_score: number | null
    away_score: number | null
  }> =>
    await db!
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id', 'home_score', 'away_score'])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
  /** A Hawks home game against Dunlins, held under `id`. */
  const sidedGame = async (
    id: string
  ): Promise<{ row: object; gameId: string; dunlins: string }> => {
    const row = {
      ...springRow(),
      externalId: { system: 'otherLeague', id }
    }
    const made = await schedule('owner', { games: [row] })
    const gameId: string = made.body.results[0].gameId
    return { row, gameId, dunlins: await awayTeamOf(gameId) }
  }
  const playOn = async (gameId: string): Promise<void> => {
    const play = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'stolen_base', awayScore: null, homeScore: null }
    }
    await sql`insert into events (id, "gameId", "battingTeamId", gumbo)
      values (${makeId('event')}, ${gameId}, ${hawks}, ${JSON.stringify(play)}::jsonb)`.execute(
      db!
    )
  }

  let nextPlayer = 7001
  /**
   * Nine players a side saved as the scoring screen saves lineups, then
   * `after`. The away side's leadoff is returned.
   */
  const saveLineups = async (
    gameId: string,
    after: ScoringAction[] = []
  ): Promise<{ awayLeadoff: number; homeLeadoff: number }> => {
    const start = nextPlayer
    nextPlayer += 18
    await insertFixtureUsers(
      db!,
      Array.from({ length: 18 }, (_, i) => ({
        id: start + i,
        legacyId: makeId('user'),
        display_name: `Player ${i + 1}`
      }))
    )
    const game = await sidesOf(gameId)
    const teams = {
      away: { id: game.away_team_id, name: 'Away' },
      home: { id: game.home_team_id, name: 'Home' }
    }
    const roster = (first: number): Parameters<typeof newSetup>[1]['away'] =>
      Array.from({ length: 9 }, (_, i) => ({
        userId: userIdOfGumbo(first + i),
        gumboId: first + i,
        shortName: `Player ${first + i}`,
        jersey: String(i + 1)
      }))
    const setup = newSetup(teams, {
      away: roster(start),
      home: roster(start + 9)
    })
    const session = await ScoringSession.open(
      {
        load: async () => {
          const row = await db!
            .selectFrom('games')
            .selectAll()
            .where('id', '=', gameId)
            .executeTakeFirstOrThrow()
          return {
            plays: (await readPlays(db!, gameId)).map(
              play => play.gumbo as GumboPlay
            ),
            currentPlay: row.currentPlay as CurrentPlay | null,
            lineupsDigest: await storedLineupsDigest(db!, row)
          }
        },
        save: async (_id, change) => {
          const posted = await postGamePlays(
            db!,
            gameId,
            asPostEventsBody({
              ...change,
              mode: 'live',
              source: { system: 'teamstation' }
            })
          )
          return {
            plays: posted.plays.map(play => play.gumbo as GumboPlay),
            currentPlay: posted.currentPlay as CurrentPlay | null
          }
        }
      },
      gameId,
      { gamePk: gameId, teams, setup },
      { setTimer: () => null, clearTimer: () => undefined }
    )
    for (const action of [
      {
        type: 'lineup',
        kind: 'roster',
        setup,
        confirmed: ['away', 'home']
      } satisfies ScoringAction,
      ...after
    ])
      expect(session.apply(action).problems).deep.equals([])
    await session.flush()
    expect(session.problem).equals(null)
    return { awayLeadoff: start, homeLeadoff: start + 9 }
  }

  it('swaps home and away on a matched game with no plays, and announces it', async function () {
    const { row, gameId, dunlins } = await sidedGame('side-1')
    const listener = new Client({ connectionString: scratchUrl })
    await listener.connect()
    const heard: unknown[] = []
    listener.on('notification', message => {
      if (message.channel === 'game_changes' && message.payload != null) {
        heard.push(JSON.parse(message.payload))
      }
    })
    await listener.query('LISTEN game_changes')
    try {
      const announced = { game: gameId, kind: 'game' }
      const hear = async (): Promise<void> => {
        for (let tries = 0; tries < 50 && heard.length === 0; tries++) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }

      // The same side changes nothing, and says nothing.
      const same = await schedule('owner', {
        games: [{ ...row, side: 'home' }]
      })
      expect(same.body.results[0].result).equals('unchanged')
      await hear()
      expect(heard).deep.equals([])

      // Scores a game without plays should not have still follow their teams.
      await db!
        .updateTable('games')
        .set({ home_score: 1, away_score: 4 })
        .where('id', '=', gameId)
        .execute()
      const swapped = await schedule('owner', {
        games: [{ ...row, side: 'away' }]
      })
      expect(swapped.body.results[0]).deep.include({
        result: 'updated',
        gameId,
        status: 'scheduled'
      })
      expect(await sidesOf(gameId)).deep.equals({
        home_team_id: dunlins,
        away_team_id: hawks,
        home_score: 4,
        away_score: 1
      })
      await hear()
      expect(heard).deep.equals([announced])

      // A cancelled game with no plays swaps back.
      const back = await schedule('owner', {
        games: [{ ...row, side: 'home', status: 'cancelled' }]
      })
      expect(back.body.results[0]).deep.include({
        result: 'updated',
        status: 'cancelled'
      })
      expect(await sidesOf(gameId)).deep.include({
        home_team_id: hawks,
        away_team_id: dunlins
      })
    } finally {
      await listener.end()
    }
  })

  it('keeps the sides of a game with plays stored or under way', async function () {
    const { row, gameId, dunlins } = await sidedGame('side-2')
    const kept = { home_team_id: hawks, away_team_id: dunlins }
    await playOn(gameId)
    const stored = await schedule('owner', {
      games: [{ ...row, side: 'away' }]
    })
    expect(stored.status).equals(200)
    expect(stored.body.results[0].result).equals('unchanged')
    expect(await sidesOf(gameId)).deep.include(kept)

    // An at-bat with a pitch thrown is under way, though no play is stored
    // yet: the game is in progress, and the import leaves it as it is.
    await db!.deleteFrom('events').where('gameId', '=', gameId).execute()
    await saveLineups(gameId, [{ type: 'pitch', call: 'B' }])
    const pitched = await schedule('owner', {
      games: [{ ...row, side: 'away' }]
    })
    expect(pitched.body.results[0]).deep.include({
      result: 'unchanged',
      status: 'inProgress'
    })
    expect(await sidesOf(gameId)).deep.include(kept)

    // An at-bat TeamStation did not score is under way too. Other fields
    // still apply.
    await sql`update games set "currentPlay" = '{}'::jsonb, status = 'scheduled' where id = ${gameId}`.execute(
      db!
    )
    const outside = await schedule('owner', {
      games: [{ ...row, side: 'away', venue: 'Field 10' }]
    })
    expect(outside.body.results[0].result).equals('updated')
    expect(await sidesOf(gameId)).deep.include(kept)
  })

  it('swaps a game holding saved lineups, with its guests, and tells the scoreboard', async function () {
    const { row, gameId, dunlins } = await sidedGame('side-lineups')
    const { homeLeadoff } = await saveLineups(gameId)
    await insertFixtureUsers(db!, {
      id: 7999,
      legacyId: makeId('user'),
      display_name: 'Gus Guest'
    })
    await db!
      .updateTable('games')
      .set({ guests: { home: [7999], away: [] } })
      .where('id', '=', gameId)
      .execute()
    written.length = 0
    const swapped = await schedule('owner', {
      games: [{ ...row, side: 'away' }]
    })
    expect(swapped.body.results[0]).deep.include({
      result: 'updated',
      gameId
    })
    expect(await sidesOf(gameId)).deep.include({
      home_team_id: dunlins,
      away_team_id: hawks
    })
    const game = await db!
      .selectFrom('games')
      .select([
        'id',
        'guests',
        'home_team_id',
        'away_team_id',
        'currentPlay',
        'pregame',
        'lineups_digest',
        'play_generation'
      ])
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(storedGuests(game.guests, teamsOfRow(game))).deep.equals({
      home: [],
      away: [7999]
    })
    // The Hawks, away now, bat first.
    expect(game.currentPlay).equals(null)
    expect(
      (await lineupsAnswer(db!, game)).away.current?.batters[0]?.gumboId
    ).equals(homeLeadoff)
    expect(written).deep.equals([gameId])

    // The same side again is no write, and the scoreboard hears nothing.
    written.length = 0
    const again = await schedule('owner', {
      games: [{ ...row, side: 'away' }]
    })
    expect(again.body.results[0].result).equals('unchanged')
    expect(written).deep.equals([])
  })

  it('keeps the sides of a game between two full teams', async function () {
    const row = {
      ...springRow(),
      opponent: { teamId: gulls },
      externalId: { system: 'otherLeague', id: 'side-4' }
    }
    const made = await schedule('owner', { games: [row] })
    const gameId: string = made.body.results[0].gameId
    const answer = await schedule('owner', {
      games: [{ ...row, side: 'away' }]
    })
    expect(answer.body.results[0].result).equals('unchanged')
    expect(await sidesOf(gameId)).deep.include({
      home_team_id: hawks,
      away_team_id: gulls
    })
  })

  it('keeps the sides of a final game', async function () {
    const { row, gameId, dunlins } = await sidedGame('side-3')
    await db!
      .updateTable('games')
      .set({ status: 'final' })
      .where('id', '=', gameId)
      .execute()
    const answer = await schedule('owner', {
      games: [{ ...row, side: 'away' }]
    })
    expect(answer.body.results[0]).deep.include({
      result: 'unchanged',
      status: 'final'
    })
    expect(await sidesOf(gameId)).deep.include({
      home_team_id: hawks,
      away_team_id: dunlins
    })
  })

  const userOf = (person: Person): number => users.get(person) ?? 0
  const teamsNamed = async (
    name: string
  ): Promise<Array<{ id: string; kind: 'full' | 'external' }>> =>
    await db!
      .selectFrom('teams')
      .select(['id', 'kind'])
      .where('name', '=', name)
      .execute()
  const gamesOf = async (teamId: string): Promise<string[]> =>
    (
      await db!
        .selectFrom('games')
        .select('id')
        .where(eb =>
          eb.or([
            eb('home_team_id', '=', teamId),
            eb('away_team_id', '=', teamId)
          ])
        )
        .execute()
    ).map(game => game.id)
  /** A Hawks home game held under `key` against a new external `name`. */
  const placeholderGame = async (
    key: string,
    name: string
  ): Promise<{ row: object; gameId: string; placeholder: string }> => {
    const row = {
      ...springRow(),
      opponent: { name },
      externalId: { system: 'otherLeague', id: key }
    }
    const made = await schedule('owner', { games: [row] })
    const gameId: string = made.body.results[0].gameId
    return { row, gameId, placeholder: await awayTeamOf(gameId) }
  }
  /** A single, credited to the batter's side and to the pitcher's. */
  const single = (
    atBatIndex: number,
    halfInning: 'top' | 'bottom',
    batter: { id: number; teamId: string },
    pitcher: { id: number; teamId: string }
  ): GumboPlay => ({
    about: { atBatIndex, inning: 1, halfInning },
    result: { eventType: 'single', awayScore: 0, homeScore: 0 },
    count: { outs: 0 },
    matchup: { batter: { id: batter.id }, pitcher: { id: pitcher.id } },
    runners: [
      {
        movement: { start: null, end: '1B', isOut: false },
        details: { eventType: 'single', runner: { id: batter.id } }
      }
    ],
    credits: [
      {
        eventType: 'single',
        label: 'Single',
        teamId: batter.teamId,
        creditUserId: batter.id,
        credit: { name: 'Batter', role: 'batter', position: null }
      },
      {
        eventType: 'single',
        label: 'Pitched',
        teamId: pitcher.teamId,
        creditUserId: pitcher.id,
        credit: { name: 'Pitcher', role: 'pitcher', position: null }
      }
    ]
  })
  /**
   * A final game, 3-2 to the Hawks at home, against a placeholder: a single
   * each way, credits on both sides, a fielder and a camera key of the
   * placeholder's, and its stats built.
   */
  const finishedGame = async (
    key: string,
    name: string
  ): Promise<{ row: object; gameId: string; placeholder: string }> => {
    const made = await placeholderGame(key, name)
    const { gameId, placeholder } = made
    await db!
      .updateTable('games')
      .set({ status: 'final', home_score: 3, away_score: 2 })
      .where('id', '=', gameId)
      .execute()
    const theirs = (person: Person): { id: number; teamId: string } => ({
      id: userOf(person),
      teamId: placeholder
    })
    const ours = (person: Person): { id: number; teamId: string } => ({
      id: userOf(person),
      teamId: hawks
    })
    await replaceGameEvents(db!, {
      gameId,
      homeTeamId: hawks,
      awayTeamId: placeholder,
      plays: [
        single(0, 'top', theirs('member'), ours('owner')),
        single(1, 'bottom', ours('manager'), theirs('parent'))
      ].map(gumbo => ({ gumbo, source: 'external' as const }))
    })
    const top = await db!
      .selectFrom('events')
      .select('id')
      .where('gameId', '=', gameId)
      .where('atBatIndex', '=', 0)
      .executeTakeFirstOrThrow()
    await db!
      .insertInto('event_players')
      .values({
        id: makeId('eventPlayer'),
        event_id: top.id,
        gumbo_id: userOf('leagueAdmin'),
        team_id: placeholder,
        role: 'fielder',
        position: 'SS'
      })
      .execute()
    await db!
      .insertInto('live_streams')
      .values({
        id: makeId('liveStream'),
        game_id: gameId,
        team_id: placeholder,
        user_id: userIdOfGumbo(userOf('site')),
        key_hash: `hash_${key}`,
        key_prefix: 'prefix',
        key_cipher: 'cipher',
        opens_at: new Date()
      })
      .execute()
    await drain(db!, () => new Date())
    return made
  }
  /** Each person named by the game's rows of `table`, with their team. */
  const teamsByPerson = async (
    gameId: string,
    table: 'event_players' | 'game_player_stats'
  ): Promise<Record<string, string | null>> => {
    const rows =
      table === 'event_players'
        ? await db!
            .selectFrom('event_players')
            .innerJoin('events', 'events.id', 'event_players.event_id')
            .select([
              'event_players.gumbo_id as userId',
              'event_players.team_id as teamId'
            ])
            .where('events.gameId', '=', gameId)
            .execute()
        : await db!
            .selectFrom('game_player_stats')
            .select(['gumbo_id as userId', 'team_id as teamId'])
            .where('game_id', '=', gameId)
            .execute()
    const byPerson: Record<string, string | null> = {}
    for (const person of PEOPLE) {
      const teams = new Set(
        rows.filter(row => row.userId === userOf(person)).map(row => row.teamId)
      )
      if (teams.size > 1) throw new Error(`${person} is on two teams`)
      if (teams.size === 1) byPerson[person] = [...teams][0]
    }
    return byPerson
  }

  it('moves a final game with plays to the opponent its row now names, with everything of the old one’s', async function () {
    const { row, gameId, placeholder } = await finishedGame('final-1', 'TBD-1')
    expect(await teamsByPerson(gameId, 'game_player_stats')).deep.equals({
      member: placeholder,
      parent: placeholder,
      owner: hawks,
      manager: hawks
    })

    const answer = await schedule('owner', {
      games: [{ ...row, opponent: { name: 'Copperheads' } }]
    })
    expect(answer.body.results[0]).deep.include({
      result: 'updated',
      gameId,
      status: 'final'
    })
    const [copperheads, ...others] = await teamsNamed('Copperheads')
    expect(others).deep.equals([])
    expect(copperheads.kind).equals('external')
    expect(await sidesOf(gameId)).deep.equals({
      home_team_id: hawks,
      away_team_id: copperheads.id,
      home_score: 3,
      away_score: 2
    })

    const plays = await db!
      .selectFrom('events')
      .select(['atBatIndex', 'battingTeamId', 'gumbo'])
      .where('gameId', '=', gameId)
      .orderBy('atBatIndex')
      .execute()
    expect(plays.map(play => play.battingTeamId)).deep.equals([
      copperheads.id,
      hawks
    ])
    expect(
      plays.map(play =>
        (play.gumbo as { credits: Array<{ teamId: string }> }).credits.map(
          credit => credit.teamId
        )
      )
    ).deep.equals([
      [copperheads.id, hawks],
      [hawks, copperheads.id]
    ])
    const credits = await db!
      .selectFrom('eventCredits')
      .innerJoin('events', 'events.id', 'eventCredits.eventId')
      .select(['events.atBatIndex as atBatIndex', 'eventCredits.teamId'])
      .where('events.gameId', '=', gameId)
      .orderBy('events.atBatIndex')
      .orderBy('eventCredits.label', 'desc')
      .execute()
    expect(credits.map(credit => credit.teamId)).deep.equals([
      copperheads.id,
      hawks,
      hawks,
      copperheads.id
    ])
    expect(await teamsByPerson(gameId, 'event_players')).deep.equals({
      member: copperheads.id,
      parent: copperheads.id,
      leagueAdmin: copperheads.id,
      owner: hawks,
      manager: hawks
    })
    const stream = await db!
      .selectFrom('live_streams')
      .select('team_id')
      .where('game_id', '=', gameId)
      .executeTakeFirstOrThrow()
    expect(stream.team_id).equals(copperheads.id)

    await drain(db!, () => new Date())
    expect(await teamsByPerson(gameId, 'game_player_stats')).deep.equals({
      member: copperheads.id,
      parent: copperheads.id,
      owner: hawks,
      manager: hawks
    })

    // The placeholder stays, with no games; nothing prunes a team.
    expect(await teamsNamed('TBD-1')).deep.equals([
      { id: placeholder, kind: 'external' }
    ])
    expect(await gamesOf(placeholder)).deep.equals([])

    // The same name again, in another case and spacing, changes nothing.
    const again = await schedule('owner', {
      games: [{ ...row, opponent: { name: '  COPPERHEADS ' } }]
    })
    expect(again.body.results[0].result).equals('unchanged')
    expect(await awayTeamOf(gameId)).equals(copperheads.id)
  })

  it('moves a game to an external team or a season team its name finds, and a full team’s game never', async function () {
    const rattlers = await teamsNamed('Rattlers')
    expect(rattlers).length(1)
    const first = await placeholderGame('found-1', 'Placeholder R')
    const toRattlers = await schedule('owner', {
      games: [{ ...first.row, opponent: { name: 'rattlers' } }]
    })
    expect(toRattlers.body.results[0].result).equals('updated')
    expect(await awayTeamOf(first.gameId)).equals(rattlers[0].id)
    expect(await teamsNamed('rattlers')).deep.equals([])
    expect(await teamsNamed('Rattlers')).deep.equals(rattlers)

    const second = await placeholderGame('found-2', 'Placeholder G')
    const toGulls = await schedule('owner', {
      games: [{ ...second.row, opponent: { name: 'Gulls' } }]
    })
    expect(toGulls.body.results[0].result).equals('updated')
    expect(await awayTeamOf(second.gameId)).equals(gulls)

    // The Gulls are a full team: their game keeps them, by name or by id.
    for (const opponent of [{ name: 'Hornets' }, { teamId: outsiders }]) {
      const kept = await schedule('owner', {
        games: [{ ...second.row, opponent }]
      })
      expect(kept.body.results[0].result).equals('unchanged')
      expect(await awayTeamOf(second.gameId)).equals(gulls)
    }
    expect(await teamsNamed('Hornets')).deep.equals([])
  })

  /** What `game_changes` carries while `act` runs, waiting for `count`. */
  const listening = async <T>(
    act: () => Promise<T>,
    count: number
  ): Promise<{ result: T; heard: unknown[] }> => {
    const listener = new Client({ connectionString: scratchUrl })
    await listener.connect()
    const heard: unknown[] = []
    listener.on('notification', message => {
      if (message.channel === 'game_changes' && message.payload != null) {
        heard.push(JSON.parse(message.payload))
      }
    })
    await listener.query('LISTEN game_changes')
    try {
      const result = await act()
      for (let tries = 0; tries < 50 && heard.length < count; tries++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      await new Promise(resolve => setTimeout(resolve, 50))
      return { result, heard }
    } finally {
      await listener.end()
    }
  }

  it('never moves a game for a name that says its opponent is not known yet', async function () {
    const { row, gameId, placeholder } = await finishedGame(
      'undetermined-1',
      'TBD-2'
    )
    for (const name of ['TBD', 'TBA', 'To be determined', 'tbd Oct 04']) {
      const answer = await schedule('owner', {
        games: [
          {
            ...row,
            opponent: { name, externalId: opponentKey('undetermined-o1') }
          }
        ]
      })
      expect(answer.body.results[0].result, name).equals('unchanged')
      expect(await awayTeamOf(gameId), name).equals(placeholder)
      expect(await teamsNamed(name), name).deep.equals([])
    }
    // Nor does the placeholder take the id a placeholder row carried.
    expect(await holdersOf('undetermined-o1')).deep.equals([])
    expect(await teamsNamed('TBD-2')).deep.equals([
      { id: placeholder, kind: 'external' }
    ])

    // A real name still moves it.
    const named = await schedule('owner', {
      games: [{ ...row, opponent: { name: 'Cobras' } }]
    })
    expect(named.body.results[0].result).equals('updated')
    const [cobras] = await teamsNamed('Cobras')
    expect(await awayTeamOf(gameId)).equals(cobras.id)
  })

  it('refuses to move a game onto a full team that already has it', async function () {
    const { row, gameId, placeholder } = await placeholderGame(
      'twin-1',
      'Placeholder T'
    )
    const { start_at: startAt } = await db!
      .selectFrom('games')
      .select('start_at')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow()
    const twin = makeId('game')
    await db!
      .insertInto('games')
      .values({
        id: twin,
        home_team_id: gulls,
        away_team_id: hawks,
        season_id: spring,
        start_at: startAt
      })
      .execute()
    const answer = await schedule('owner', {
      games: [{ ...row, opponent: { name: 'Gulls' } }]
    })
    expect(answer.body.results[0]).deep.equals({
      index: 0,
      result: 'error',
      error: { code: 'conflict', message: 'Gulls already has this game' }
    })
    expect(await awayTeamOf(gameId)).equals(placeholder)
    await db!.deleteFrom('games').where('id', '=', twin).execute()
  })

  it('keeps the opponent when the row names the team itself, applies the rest, and never guesses by a coach', async function () {
    // The team's own name, however it is written: the opponent stays.
    const own = await placeholderGame('self-0', 'Placeholder S0')
    const later = new Date(Date.UTC(2026, 4, 1, 17, minute)).toISOString()
    const answer = await schedule('owner', {
      games: [{ ...own.row, startAt: later, opponent: { name: 'hawks' } }]
    })
    expect(answer.body.results[0]).deep.include({
      result: 'updated',
      gameId: own.gameId,
      status: 'scheduled'
    })
    expect(await awayTeamOf(own.gameId)).equals(own.placeholder)
    const { start_at: moved } = await db!
      .selectFrom('games')
      .select('start_at')
      .where('id', '=', own.gameId)
      .executeTakeFirstOrThrow()
    expect(new Date(moved).toISOString()).equals(later)

    // A name ending in a team's last word is another club: a new external
    // team, never the team itself or a season team by its coach.
    for (const [index, name] of ['Coastal Hawks', 'Seaside Gulls'].entries()) {
      const { row, gameId } = await placeholderGame(
        `coach-${index}`,
        `Placeholder C${index}`
      )
      const moved = await schedule('owner', {
        games: [{ ...row, opponent: { name } }]
      })
      expect(moved.body.results[0].result, name).equals('updated')
      const [made, ...others] = await teamsNamed(name)
      expect(others, name).deep.equals([])
      expect(made.kind, name).equals('external')
      expect(await awayTeamOf(gameId), name).equals(made.id)
    }
  })

  it('renames a team its id finds to a name ending in a season team’s last word', async function () {
    const gameKey = (id: string): object => ({ system: 'otherLeague', id })
    const row = {
      ...springRow(),
      opponent: { name: 'Geckos', externalId: opponentKey('geckos-1') },
      externalId: gameKey('geckos-g1')
    }
    const made = await schedule('owner', { games: [row] })
    const gameId: string = made.body.results[0].gameId
    const geckos = await awayTeamOf(gameId)
    const renamed = {
      ...row,
      opponent: { name: 'Coastal Gulls', externalId: opponentKey('geckos-1') }
    }
    const answer = await schedule('owner', { games: [renamed] })
    expect(answer.body.results[0].result).equals('updated')
    expect(await awayTeamOf(gameId)).equals(geckos)
    expect(await teamsNamed('Coastal Gulls')).deep.equals([
      { id: geckos, kind: 'external' }
    ])
    expect(await gamesOf(gulls)).not.includes(gameId)
  })

  it('moves a held game to the team its id finds, and gives that team the row’s name, in one press', async function () {
    const gameKey = (id: string): object => ({ system: 'otherLeague', id })
    const first = await schedule('owner', {
      games: [
        {
          ...springRow(),
          opponent: { name: 'Iguanas', externalId: opponentKey('iguanas-1') },
          externalId: gameKey('iguanas-g1')
        }
      ]
    })
    const iguanas = await awayTeamOf(first.body.results[0].gameId)
    const held = await placeholderGame('iguanas-g2', 'Placeholder I')
    const named = {
      ...held.row,
      opponent: { name: 'Iguanas Club', externalId: opponentKey('iguanas-1') }
    }
    const answer = await schedule('owner', { games: [named] })
    expect(answer.body.results[0].result).equals('updated')
    expect(await awayTeamOf(held.gameId)).equals(iguanas)
    expect(await teamsNamed('Iguanas Club')).deep.equals([
      { id: iguanas, kind: 'external' }
    ])
    const again = await schedule('owner', { games: [named] })
    expect(again.body.results[0].result).equals('unchanged')
  })

  it('moves a game off an external team other schedules share rather than renaming it', async function () {
    const gameKey = (id: string): object => ({ system: 'otherLeague', id })
    const ours = {
      ...springRow(),
      opponent: { name: 'Mambas', externalId: opponentKey('mambas-a') },
      externalId: gameKey('shared-a')
    }
    const made = await schedule('owner', { games: [ours] })
    const oursId: string = made.body.results[0].gameId
    const mambas = await awayTeamOf(oursId)
    const theirs = await schedule(
      'site',
      {
        games: [
          {
            ...springRow(),
            opponent: { name: 'Mambas' },
            externalId: gameKey('shared-b')
          }
        ]
      },
      gulls
    )
    const theirsId: string = theirs.body.results[0].gameId
    expect(await awayTeamOf(theirsId)).equals(mambas)

    const answer = await schedule('owner', {
      games: [
        {
          ...ours,
          opponent: {
            name: 'Mambas Elite',
            externalId: opponentKey('mambas-a')
          }
        }
      ]
    })
    expect(answer.body.results[0].result).equals('updated')
    const [elite, ...others] = await teamsNamed('Mambas Elite')
    expect(others).deep.equals([])
    expect(elite.kind).equals('external')
    expect(await awayTeamOf(oursId)).equals(elite.id)
    expect(await teamsNamed('Mambas')).deep.equals([
      { id: mambas, kind: 'external' }
    ])
    expect(await awayTeamOf(theirsId)).equals(mambas)
    // The id stays where it was, and the same row again moves nothing back.
    expect(await holdersOf('mambas-a')).deep.equals([
      { entity_type: 'team', entity_id: mambas }
    ])
    const again = await schedule('owner', {
      games: [
        {
          ...ours,
          opponent: {
            name: 'Mambas Elite',
            externalId: opponentKey('mambas-a')
          }
        }
      ]
    })
    expect(again.body.results[0].result).equals('unchanged')
    expect(await awayTeamOf(oursId)).equals(elite.id)
  })

  it('finds by name, not by its id, an opponent other teams’ games share, and a second press moves nothing', async function () {
    const gameKey = (id: string): object => ({ system: 'otherLeague', id })
    const first = await schedule('owner', {
      games: [
        {
          ...springRow(),
          opponent: { name: 'Coyotes', externalId: opponentKey('coyotes-a') },
          externalId: gameKey('coyotes-g1')
        }
      ]
    })
    const coyotes = await awayTeamOf(first.body.results[0].gameId)
    await schedule(
      'site',
      { games: [{ ...springRow(), opponent: { name: 'Coyotes' } }] },
      gulls
    )
    const named = {
      name: 'Coyotes Select 12U',
      externalId: opponentKey('coyotes-a')
    }

    // A new game.
    const fresh = {
      ...springRow(),
      opponent: named,
      externalId: gameKey('coyotes-g2')
    }
    const created = await schedule('owner', { games: [fresh] })
    expect(created.body.results[0].result).equals('created')
    const freshId: string = created.body.results[0].gameId
    const [select, ...others] = await teamsNamed('Coyotes Select 12U')
    expect(others).deep.equals([])
    expect(select.kind).equals('external')
    expect(await awayTeamOf(freshId)).equals(select.id)
    const again = await schedule('owner', { games: [fresh] })
    expect(again.body.results[0].result).equals('unchanged')
    expect(await awayTeamOf(freshId)).equals(select.id)

    // A held game on a placeholder.
    const held = await placeholderGame('coyotes-g3', 'Placeholder K')
    const moved = await schedule('owner', {
      games: [{ ...held.row, opponent: named }]
    })
    expect(moved.body.results[0].result).equals('updated')
    expect(await awayTeamOf(held.gameId)).equals(select.id)
    const still = await schedule('owner', {
      games: [{ ...held.row, opponent: named }]
    })
    expect(still.body.results[0].result).equals('unchanged')
    expect(await awayTeamOf(held.gameId)).equals(select.id)

    // The shared team keeps its name and the id.
    expect(await teamsNamed('Coyotes')).deep.equals([
      { id: coyotes, kind: 'external' }
    ])
    expect(await holdersOf('coyotes-a')).deep.equals([
      { entity_type: 'team', entity_id: coyotes }
    ])
  })

  it('gives a placeholder no id, and never renames one that has an id', async function () {
    // A new game against a placeholder: the id is not recorded on it.
    const made = await schedule('owner', {
      games: [
        {
          ...springRow(),
          opponent: { name: 'TBA', externalId: opponentKey('tba-1') }
        }
      ]
    })
    expect(made.body.results[0].result).equals('created')
    expect(await teamsNamed('TBA')).length(1)
    expect(await holdersOf('tba-1')).deep.equals([])

    // A placeholder that holds an id from before.
    const { row, gameId, placeholder } = await placeholderGame(
      'tbd-held-1',
      'TBD- 01/02'
    )
    await db!
      .insertInto('external_ids')
      .values({
        id: makeId('externalId'),
        entity_type: 'team',
        entity_id: placeholder,
        system: 'otherLeague',
        kind: 'opponent',
        external_id: 'tbd-held-o1'
      })
      .execute()
    const named = { name: 'Kingsnakes', externalId: opponentKey('tbd-held-o1') }
    const answer = await schedule('owner', {
      games: [{ ...row, opponent: named }]
    })
    expect(answer.body.results[0].result).equals('updated')
    const [kingsnakes] = await teamsNamed('Kingsnakes')
    expect(await awayTeamOf(gameId)).equals(kingsnakes.id)
    expect(await teamsNamed('TBD- 01/02')).deep.equals([
      { id: placeholder, kind: 'external' }
    ])
    const again = await schedule('owner', {
      games: [{ ...row, opponent: named }]
    })
    expect(again.body.results[0].result).equals('unchanged')
  })

  it('moves a game to the team that already has the new name rather than renaming its own', async function () {
    const gameKey = (id: string): object => ({ system: 'otherLeague', id })
    const made = await schedule('owner', {
      games: [
        { ...springRow(), opponent: { name: 'Pythons' } },
        {
          ...springRow(),
          opponent: { name: 'Boas', externalId: opponentKey('boas-1') },
          externalId: gameKey('boas-g1')
        }
      ]
    })
    const pythons = await awayTeamOf(made.body.results[0].gameId)
    const gameId: string = made.body.results[1].gameId
    const boas = await awayTeamOf(gameId)
    const row = {
      ...springRow(),
      opponent: { name: 'pythons', externalId: opponentKey('boas-1') },
      externalId: gameKey('boas-g1')
    }
    const answer = await schedule('owner', { games: [row] })
    expect(answer.body.results[0].result).equals('updated')
    expect(await awayTeamOf(gameId)).equals(pythons)
    expect(await teamsNamed('Boas')).deep.equals([
      { id: boas, kind: 'external' }
    ])
    expect(await teamsNamed('pythons')).deep.equals([])
    const again = await schedule('owner', { games: [row] })
    expect(again.body.results[0].result).equals('unchanged')

    // A new game with the same row lands on the Pythons too, and stays.
    const fresh = {
      ...springRow(),
      opponent: row.opponent,
      externalId: gameKey('boas-g2')
    }
    const created = await schedule('owner', { games: [fresh] })
    expect(created.body.results[0].result).equals('created')
    const freshId: string = created.body.results[0].gameId
    expect(await awayTeamOf(freshId)).equals(pythons)
    const still = await schedule('owner', { games: [fresh] })
    expect(still.body.results[0].result).equals('unchanged')
    expect(await awayTeamOf(freshId)).equals(pythons)
  })

  it('renames an external opponent the row’s id finds, in every game it plays', async function () {
    const vipers = {
      ...springRow(),
      opponent: { name: 'Vipers', externalId: opponentKey('vipers-1') }
    }
    const gameKey = (id: string): object => ({ system: 'otherLeague', id })
    const made = await schedule('owner', {
      games: [
        { ...vipers, externalId: gameKey('rename-1') },
        { ...springRow(), opponent: vipers.opponent }
      ]
    })
    const [renamed, other] = made.body.results.map((r: any) => r.gameId)
    const team = await awayTeamOf(renamed)
    expect(await awayTeamOf(other)).equals(team)

    const answer = await listening(
      async () =>
        await schedule('owner', {
          games: [
            {
              ...vipers,
              opponent: {
                name: 'Vipers Elite',
                externalId: opponentKey('vipers-1')
              },
              externalId: gameKey('rename-1')
            }
          ]
        }),
      2
    )
    // Every screen holding a game against the team hears of its new name.
    expect(
      answer.heard.map(payload => JSON.stringify(payload)).sort()
    ).deep.equals(
      [renamed, other]
        .map(game => JSON.stringify({ game, kind: 'game' }))
        .sort()
    )
    expect(answer.result.body.results[0].result).equals('updated')
    expect(await awayTeamOf(renamed)).equals(team)
    expect(await teamsNamed('Vipers Elite')).deep.equals([
      { id: team, kind: 'external' }
    ])
    const otherGame = await db!
      .selectFrom('games')
      .innerJoin('teams', 'teams.id', 'games.away_team_id')
      .select('teams.name')
      .where('games.id', '=', other)
      .executeTakeFirstOrThrow()
    expect(otherGame.name).equals('Vipers Elite')

    // The same name again is no change.
    const again = await schedule('owner', {
      games: [
        {
          ...vipers,
          opponent: {
            name: 'vipers elite',
            externalId: opponentKey('vipers-1')
          },
          externalId: gameKey('rename-1')
        }
      ]
    })
    expect(again.body.results[0].result).equals('unchanged')
    expect(await teamsNamed('Vipers Elite')).length(1)
  })

  it('keeps the opponent of a game scored in TeamStation, and applies the rest of the row', async function () {
    for (const how of ['record', 'currentPlay', 'scoringOwner'] as const) {
      const { row, gameId, placeholder } = await placeholderGame(
        `scored-${how}`,
        `Scored ${how}`
      )
      if (how === 'record') {
        const play = {
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          result: {
            eventType: 'stolen_base',
            awayScore: null,
            homeScore: null
          },
          teamStation: { version: 1 }
        }
        await sql`insert into events (id, "gameId", "battingTeamId", gumbo)
          values (${makeId('event')}, ${gameId}, ${placeholder}, ${JSON.stringify(play)}::jsonb)`.execute(
          db!
        )
      } else if (how === 'currentPlay') {
        await sql`update games set "currentPlay" = '{}'::jsonb where id = ${gameId}`.execute(
          db!
        )
      } else {
        // A lineup posted from TeamStation's scorer, and no play yet.
        await db!
          .updateTable('games')
          .set({ scoringOwner: 'teamstation' })
          .where('id', '=', gameId)
          .execute()
      }
      // The opponent alone is refused: the same name changes nothing, and
      // a later time still moves the game.
      const same = await schedule('owner', {
        games: [{ ...row, opponent: { name: `Fresh ${how}` } }]
      })
      expect(same.body.results[0], how).deep.equals({
        index: 0,
        result: 'unchanged',
        gameId,
        status: 'scheduled'
      })
      const later = new Date(Date.UTC(2026, 4, 2, 17, minute)).toISOString()
      const moved = await schedule('owner', {
        games: [{ ...row, startAt: later, opponent: { name: `Fresh ${how}` } }]
      })
      expect(moved.body.results[0], how).deep.equals({
        index: 0,
        result: 'updated',
        gameId,
        status: 'scheduled'
      })
      const { start_at: startAt } = await db!
        .selectFrom('games')
        .select('start_at')
        .where('id', '=', gameId)
        .executeTakeFirstOrThrow()
      expect(new Date(startAt).toISOString(), how).equals(later)
      expect(await awayTeamOf(gameId), how).equals(placeholder)
      // No team is made for an opponent the game cannot take.
      expect(await teamsNamed(`Fresh ${how}`), how).deep.equals([])
      const batting = await db!
        .selectFrom('events')
        .select('battingTeamId')
        .where('gameId', '=', gameId)
        .execute()
      expect(
        batting.map(play => play.battingTeamId),
        how
      ).deep.equals(how === 'record' ? [placeholder] : [])
    }
  })

  it('keeps or moves a held game named by its opponent\u2019s id, and records the id that comes with it', async function () {
    const { row, gameId, placeholder } = await placeholderGame(
      'by-id-1',
      'Plovers'
    )
    const [other] = await teamsNamed('Plovers')
    expect(other.id).equals(placeholder)
    const sandpipers = makeId('team')
    await db!
      .insertInto('teams')
      .values({ id: sandpipers, name: 'Sandpipers', kind: 'external' })
      .execute()

    // Its own opponent, by id: nothing changes, and the id is recorded.
    const same = await schedule('owner', {
      games: [
        {
          ...row,
          opponent: { teamId: placeholder, externalId: opponentKey('plv-1') }
        }
      ]
    })
    expect(same.body.results[0]).deep.equals({
      index: 0,
      result: 'unchanged',
      gameId,
      status: 'scheduled'
    })
    expect(await holdersOf('plv-1')).deep.equals([
      { entity_type: 'team', entity_id: placeholder }
    ])

    // Another external team, by id: the game moves to it.
    const moved = await schedule('owner', {
      games: [{ ...row, opponent: { teamId: sandpipers } }]
    })
    expect(moved.body.results[0]).deep.include({ result: 'updated', gameId })
    expect(await awayTeamOf(gameId)).equals(sandpipers)
  })

  it('gives a placeholder opponent no id, named by its id or not', async function () {
    const { row, gameId, placeholder } = await placeholderGame(
      'by-id-tbd',
      'TBD 0f0f0f0f 2026-05-02 18:00'
    )
    await db!
      .updateTable('games')
      .set({ scoringOwner: 'teamstation' })
      .where('id', '=', gameId)
      .execute()
    const answer = await schedule('owner', {
      games: [
        {
          ...row,
          opponent: { teamId: placeholder, externalId: opponentKey('tbd-1') }
        }
      ]
    })
    expect(answer.body.results[0]).deep.include({
      result: 'unchanged',
      gameId
    })
    expect(await holdersOf('tbd-1')).deep.equals([])

    // A game moved onto it by its id leaves the id free too.
    const other = await placeholderGame('by-id-tbd-2', 'Stints')
    const moved = await schedule('owner', {
      games: [
        {
          ...other.row,
          opponent: { teamId: placeholder, externalId: opponentKey('tbd-2') }
        }
      ]
    })
    expect(moved.body.results[0]).deep.include({
      result: 'updated',
      gameId: other.gameId
    })
    expect(await awayTeamOf(other.gameId)).equals(placeholder)
    expect(await holdersOf('tbd-2')).deep.equals([])
  })

  it('records the id of a scored game\u2019s own opponent, and moves it to no other', async function () {
    const { row, gameId, placeholder } = await placeholderGame(
      'by-id-scored',
      'Scored Avocets'
    )
    await db!
      .updateTable('games')
      .set({ scoringOwner: 'teamstation' })
      .where('id', '=', gameId)
      .execute()
    const stilts = makeId('team')
    await db!
      .insertInto('teams')
      .values({ id: stilts, name: 'Stilts', kind: 'external' })
      .execute()

    // Another team by id, with a free id and a new time: the opponent
    // stays, the time moves, and nobody takes the id.
    const later = new Date(Date.UTC(2026, 4, 3, 17, minute)).toISOString()
    const other = await schedule('owner', {
      games: [
        {
          ...row,
          startAt: later,
          opponent: { teamId: stilts, externalId: opponentKey('avo-1') }
        }
      ]
    })
    expect(other.body.results[0]).deep.include({ result: 'updated', gameId })
    expect(await awayTeamOf(gameId)).equals(placeholder)
    expect(await holdersOf('avo-1')).deep.equals([])

    // Its own opponent by id: the id is recorded on it.
    const own = await schedule('owner', {
      games: [
        {
          ...row,
          startAt: later,
          opponent: { teamId: placeholder, externalId: opponentKey('avo-1') }
        }
      ]
    })
    expect(own.body.results[0]).deep.include({ result: 'unchanged', gameId })
    expect(await holdersOf('avo-1')).deep.equals([
      { entity_type: 'team', entity_id: placeholder }
    ])
  })

  it('moves a scheduled game, swaps its sides in the same row, and announces it', async function () {
    const { row, gameId, dunlins } = await sidedGame('repoint-1')
    const listener = new Client({ connectionString: scratchUrl })
    await listener.connect()
    const heard: unknown[] = []
    listener.on('notification', message => {
      if (message.channel === 'game_changes' && message.payload != null) {
        heard.push(JSON.parse(message.payload))
      }
    })
    await listener.query('LISTEN game_changes')
    try {
      const answer = await schedule('owner', {
        games: [{ ...row, side: 'away', opponent: { name: 'Scorpions' } }]
      })
      expect(answer.body.results[0]).deep.include({
        result: 'updated',
        gameId,
        status: 'scheduled'
      })
      const [scorpions] = await teamsNamed('Scorpions')
      expect(await sidesOf(gameId)).deep.include({
        home_team_id: scorpions.id,
        away_team_id: hawks
      })
      expect(await gamesOf(dunlins)).not.includes(gameId)
      for (let tries = 0; tries < 50 && heard.length < 3; tries++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(heard).deep.equals(
        ['game', 'lineups', 'plays'].map(kind => ({ game: gameId, kind }))
      )
    } finally {
      await listener.end()
    }
  })

  it('keeps an opponent whose name the row writes in another case or spacing, even when another team has it', async function () {
    const { row, gameId, placeholder } = await placeholderGame(
      'same-1',
      'Placeholder Q'
    )
    // A second external team of that name, which a search might come to.
    await db!
      .insertInto('teams')
      .values({ id: makeId('team'), name: 'PLACEHOLDER Q', kind: 'external' })
      .execute()
    for (const name of ['placeholder q', '  Placeholder   Q ']) {
      const answer = await schedule('owner', {
        games: [{ ...row, opponent: { name } }]
      })
      expect(answer.body.results[0].result, name).equals('unchanged')
      expect(await awayTeamOf(gameId), name).equals(placeholder)
    }
  })

  it('moves a held game for a name written any looser way, onto a team of that exact name', async function () {
    const { row, gameId, placeholder } = await placeholderGame(
      'loose-1',
      'Otters 1'
    )
    // Case and spacing only: the same opponent.
    const same = await schedule('owner', {
      games: [{ ...row, opponent: { name: ' otters  1 ' } }]
    })
    expect(same.body.results[0].result).equals('unchanged')
    expect(await awayTeamOf(gameId)).equals(placeholder)
    // A number, punctuation or a note is another name: a new team.
    for (const name of ['Otters 2', 'Otters-1', 'Otters 1 (livestream)']) {
      const moved = await schedule('owner', {
        games: [{ ...row, opponent: { name } }]
      })
      expect(moved.body.results[0].result, name).equals('updated')
      const [made, ...more] = await teamsNamed(name)
      expect(more, name).deep.equals([])
      expect(made.kind, name).equals('external')
      expect(await awayTeamOf(gameId), name).equals(made.id)
    }
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
    await db!
      .deleteFrom('scope_roles')
      .where('user_id', '=', userIdOfGumbo(userOf('otherSeasonAdmin')))
      .where('scope_type', '=', 'team')
      .where('scope_id', '=', hawks)
      .execute()
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

  it('rechecks field authority after waiting for a parent-role change to commit', async function () {
    const connection = new Client({ connectionString: scratchUrl })
    await connection.connect()
    const before = await storedFence()
    try {
      await connection.query('begin')
      await connection.query(
        "select pg_advisory_xact_lock(hashtextextended('creation:parent-graph', 0))"
      )
      const pending = setField('seasonAdmin', { fenceDistanceFt: 190 })
      let queued = false
      for (let attempt = 0; attempt < 100 && !queued; attempt++) {
        const blocked = await connection.query<{ n: string }>(
          "select count(*) as n from pg_stat_activity where datname = current_database() and wait_event = 'advisory' and pid <> pg_backend_pid()"
        )
        queued = Number(blocked.rows[0].n) > 0
        if (!queued) await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(queued).equals(true)
      await connection.query(
        'delete from scope_roles where user_id = $1 and scope_type = $2 and scope_id = $3',
        [userIdOfGumbo(userOf('seasonAdmin')), 'season', spring]
      )
      await connection.query('commit')
      expect((await pending).status).equals(403)
      expect(await storedFence()).equals(before)
    } finally {
      await connection.query('rollback')
      await connection.end()
      await db!
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: userIdOfGumbo(userOf('seasonAdmin')),
          scope_type: 'season',
          scope_id: spring,
          role: 'admin'
        })
        .onConflict(oc =>
          oc.columns(['user_id', 'scope_type', 'scope_id', 'role']).doNothing()
        )
        .execute()
    }
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
