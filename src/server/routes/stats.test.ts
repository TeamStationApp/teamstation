import { expect } from 'chai'
import express from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { asUserId } from '../../common/userIdNumber'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { statRows } from '../stats/rows'
import { statsRoutes } from './stats'

// One player's figures, asked for the way the page asks for them.
//
// The filter is the thing a reader touches, so it is the thing under test: a
// season, a team, a year, a career, and the answer a filter that matches
// nothing gives. The rows are written straight into `game_player_stats`
// because what is being tested is the reading of them: the counting belongs
// to the stats engine that writes them.

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_statsroute_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const spring = makeId('season')
const fall = makeId('season')
const hawks = makeId('team')
const ravens = makeId('team')
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

const jordan = mintUser()
const jordanClosed = mintUser()
const stranger = mintUser()
const teammate = mintUser()
const seasonFan = mintUser()

describe('one player’s figures', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined
  let base = ''
  let server: ReturnType<express.Express['listen']> | undefined

  const ask = async (
    path: string,
    actor = jordan
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      headers: { 'x-test-actor': String(actor) }
    })
    // A refusal from the bare router is Express's own page rather than our
    // error body: this mounts the routes and not the whole server.
    const text = await res.text()
    try {
      return { status: res.status, body: JSON.parse(text) }
    } catch {
      return { status: res.status, body: text }
    }
  }

  before(async function () {
    attachInt8Parser()
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
    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

    await db
      .insertInto('seasons')
      .values([
        { id: spring, name: 'Spring 2026', year: 2026, era_innings: 6 },
        { id: fall, name: 'Fall 2025', year: 2025, era_innings: 6 }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: hawks, name: 'Alta Hawks' },
        { id: ravens, name: 'Ravens' }
      ])
      .execute()
    await db
      .insertInto('users')
      .values([
        {
          id: jordan,
          legacyId: legacyId(jordan),
          display_name: 'Jordan Pujols'
        },
        // The same child, on another team, closed into the row above.
        {
          id: jordanClosed,
          legacyId: legacyId(jordanClosed),
          display_name: 'Jordan Pujols',
          merged_into: jordan
        },
        {
          id: stranger,
          legacyId: legacyId(stranger),
          display_name: 'Somebody Else'
        }
      ])
      .execute()

    // One game in each season, for a different one of his two rows.
    const games = [
      { id: makeId('game'), season: spring, team: hawks, user: jordan },
      { id: makeId('game'), season: fall, team: ravens, user: jordanClosed }
    ]
    for (const game of games) {
      await db
        .insertInto('games')
        .values({
          id: game.id,
          home_team_id: game.team,
          away_team_id: game.team === hawks ? ravens : hawks,
          season_id: game.season,
          start_at: new Date(
            game.season === spring
              ? '2026-05-16T18:00:00Z'
              : '2025-10-04T18:00:00Z'
          ),
          status: 'final'
        })
        .execute()
      await db
        .insertInto('game_player_stats')
        .values({
          id: makeId('gamePlayerStats'),
          game_id: game.id,
          user_id: game.user,
          team_id: game.team,
          pa: 4,
          ab: 3,
          h: 2,
          singles: 2,
          r: 1,
          rbi: 1,
          bb: 1,
          pitch_bf: 6,
          pitch_outs: 6,
          pitch_er: 1
        })
        .execute()
    }

    const app = express()
    // The routes want an actor; a header stands in for the session so the
    // reading itself is what is under test.
    app.use((req, _res, next) => {
      const id = req.header('x-test-actor')
      if (id != null) {
        req.actor = { userId: asUserId(id), isAdmin: false, scopes: [] }
      }
      next()
    })
    app.use('/api/v1', statsRoutes(db))
    server = app.listen(0)
    const address = server.address()
    base =
      typeof address === 'object' && address != null
        ? `http://127.0.0.1:${address.port}/api/v1`
        : ''
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('adds up every row of one person, across the teams they played for', async function () {
    if (db == null) this.skip()
    const { body } = await ask(`/players/${jordan}/stats`)
    expect(body.games).equals(2)
    expect(body.batting.ab).equals(6)
    expect(body.batting.h).equals(4)
    expect(body.pitching.er).equals(2)
  })

  it('answers a closed row as the person it became', async function () {
    if (db == null) this.skip()
    // A link sent before the merge still has to land on the whole child.
    const { body } = await ask(`/players/${jordanClosed}/stats`)
    expect(body.userId).equals(jordan)
    expect(body.games).equals(2)
  })

  it('offers every season, team and year they have, newest first', async function () {
    if (db == null) this.skip()
    const { body } = await ask(`/players/${jordan}/stats`)
    expect(body.options.seasons.map((s: any) => s.name)).deep.equals([
      'Spring 2026',
      'Fall 2025'
    ])
    expect(body.options.teams.map((t: any) => t.name)).deep.equals([
      'Alta Hawks',
      'Ravens'
    ])
    expect(body.options.years).deep.equals([2026, 2025])
  })

  it('narrows to a season, and keeps offering the others', async function () {
    if (db == null) this.skip()
    const { body } = await ask(`/players/${jordan}/stats?seasonId=${spring}`)
    expect(body.games).equals(1)
    expect(body.batting.ab).equals(3)
    // The choice on offer must not collapse to the one already made, or there
    // is no way back to the other season.
    expect(body.options.seasons.length).equals(2)
  })

  it('narrows to a team and to a year', async function () {
    if (db == null) this.skip()
    const byTeam = await ask(`/players/${jordan}/stats?teamId=${ravens}`)
    expect(byTeam.body.games).equals(1)
    const byYear = await ask(`/players/${jordan}/stats?year=2025`)
    expect(byYear.body.games).equals(1)
    expect(byYear.body.filter.year).equals(2025)
  })

  it('says nothing rather than something wrong when a filter matches nothing', async function () {
    if (db == null) this.skip()
    const { body } = await ask(`/players/${jordan}/stats?year=2019`)
    expect(body.games).equals(0)
    expect(body.batting).equals(null)
    expect(body.pitching).equals(null)
    // And still offers the years they do have, so the reader can get back.
    expect(body.options.years).deep.equals([2026, 2025])
  })

  it('ignores a year that is not a year', async function () {
    if (db == null) this.skip()
    const { body } = await ask(`/players/${jordan}/stats?year=nonsense`)
    expect(body.games).equals(2)
    expect(body.filter.year).equals(null)
  })

  it('keeps one player’s figures from another reader who cannot see them', async function () {
    if (db == null) this.skip()
    const { status } = await ask(`/players/${jordan}/stats`, stranger)
    expect(status).equals(404)
  })

  it('divides an ERA by the season’s innings, else its league’s, else six', async function () {
    if (db == null) return this.skip()
    const divisor = async (): Promise<number[]> =>
      (await statRows(db!, { seasonId: spring })).map(row => row.eraInnings)
    const league = makeId('league')
    await db
      .insertInto('leagues')
      .values({ id: league, name: 'QPLL' })
      .execute()
    try {
      await db
        .updateTable('seasons')
        .set({ era_innings: null, league_id: league })
        .where('id', '=', spring)
        .execute()
      expect(await divisor()).deep.equals([6])

      await db
        .updateTable('leagues')
        .set({ era_innings: 7 })
        .where('id', '=', league)
        .execute()
      expect(await divisor()).deep.equals([7])

      await db
        .updateTable('seasons')
        .set({ era_innings: 5 })
        .where('id', '=', spring)
        .execute()
      expect(await divisor()).deep.equals([5])
    } finally {
      await db
        .updateTable('seasons')
        .set({ era_innings: 6, league_id: null })
        .where('id', '=', spring)
        .execute()
      await db.deleteFrom('leagues').where('id', '=', league).execute()
    }
  })

  describe('the plays behind them', function () {
    const springGame = makeId('game')
    const fallGame = makeId('game')
    const single = makeId('event')
    const hiddenOut = makeId('event')
    const double = makeId('event')

    before(async function () {
      if (db == null) return this.skip()
      const now = new Date()
      await db
        .insertInto('users')
        .values([
          {
            id: teammate,
            legacyId: legacyId(teammate),
            display_name: 'Hawks Parent'
          },
          {
            id: seasonFan,
            legacyId: legacyId(seasonFan),
            display_name: 'Fall Watcher'
          }
        ])
        .execute()
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: teammate,
          team_id: hawks,
          role: 'member'
        })
        .execute()
      await db
        .insertInto('season_members')
        .values({
          id: makeId('seasonMember'),
          user_id: seasonFan,
          season_id: fall,
          joined_at: now
        })
        .execute()
      await db
        .insertInto('games')
        .values([
          {
            id: springGame,
            home_team_id: hawks,
            away_team_id: ravens,
            season_id: spring,
            start_at: new Date('2026-05-20T18:00:00Z'),
            status: 'final'
          },
          {
            id: fallGame,
            home_team_id: ravens,
            away_team_id: hawks,
            season_id: fall,
            start_at: new Date('2025-10-10T18:00:00Z'),
            status: 'final'
          }
        ])
        .execute()
      // Each play names its batter, so the events trigger writes the
      // event_players row the route reads.
      const play = (
        id: string,
        gameId: string,
        battingTeamId: string,
        atBatIndex: number,
        eventType: string,
        batter: number,
        hidden = false
      ): Record<string, unknown> => ({
        id,
        gameId,
        battingTeamId,
        hidden,
        startTime: new Date('2026-05-20T18:30:00Z'),
        createdAt: now,
        updatedAt: now,
        gumbo: JSON.stringify({
          about: { atBatIndex, inning: 1, halfInning: 'bottom' },
          result: { eventType, rbi: 1 },
          matchup: { batter: { id: batter } }
        })
      })
      await db
        .insertInto('events')
        .values([
          play(single, springGame, hawks, 0, 'single', jordan),
          play(hiddenOut, springGame, hawks, 1, 'strikeout', jordan, true),
          // Written under the row that was later closed into Jordan's.
          play(double, fallGame, ravens, 0, 'double', jordanClosed)
        ] as never)
        .execute()
    })

    const plays = async (
      query = '',
      actor = jordan
    ): Promise<{ status: number; ids: string[]; body: any }> => {
      const answer = await ask(`/players/${jordan}/plays${query}`, actor)
      return {
        status: answer.status,
        ids: Array.isArray(answer.body)
          ? answer.body.map((row: { eventId: string }) => row.eventId)
          : [],
        body: answer.body
      }
    }

    it('lists a person’s plays across a closed row, newest game first', async function () {
      const answer = await plays()
      expect(answer.status).equals(200)
      expect(answer.ids).deep.equals([single, double])
      expect(answer.body[0]).deep.equals({
        eventId: single,
        gameId: springGame,
        atBatIndex: 0,
        inning: 1,
        halfInning: 'bottom',
        eventType: 'single',
        rbi: 1,
        role: 'batter',
        seasonId: spring,
        startTime: '2026-05-20T18:30:00.000Z'
      })
      for (const row of answer.body) {
        expect(row).not.have.property('description')
      }
    })

    it('leaves a hidden play out', async function () {
      expect((await plays()).ids).not.include(hiddenOut)
    })

    it('orders plays within a game by at-bat sequence regardless of insertion order', async function () {
      if (db == null) throw new Error('Fixture database is required')
      const later = makeId('event')
      const earlier = makeId('event')
      try {
        await db
          .insertInto('events')
          .values(
            [
              [later, 3],
              [earlier, 2]
            ].map(([id, atBatIndex]) => ({
              id,
              gameId: springGame,
              battingTeamId: hawks,
              hidden: false,
              gumbo: JSON.stringify({
                about: { atBatIndex, inning: 1, halfInning: 'bottom' },
                result: { eventType: 'single', rbi: 0 },
                matchup: { batter: { id: jordan }, pitcher: { id: jordan } }
              })
            })) as never
          )
          .execute()
        const answer = await plays()
        expect(answer.status).equals(200)
        expect(
          answer.body.map((row: { eventId: string; role: string }) => [
            row.eventId,
            row.role
          ])
        ).deep.equals([
          [single, 'batter'],
          [earlier, 'batter'],
          [earlier, 'pitcher'],
          [later, 'batter'],
          [later, 'pitcher'],
          [double, 'batter']
        ])
        expect((await plays('?role=batter')).ids).deep.equals([
          single,
          earlier,
          later,
          double
        ])
      } finally {
        await db
          .deleteFrom('events')
          .where('id', 'in', [later, earlier])
          .execute()
      }
    })

    it('narrows to a season and to an event type', async function () {
      expect((await plays(`?seasonId=${fall}`)).ids).deep.equals([double])
      expect((await plays('?eventType=single')).ids).deep.equals([single])
      expect((await plays('?role=pitcher')).ids).deep.equals([])
    })

    it('shows another reader only the plays of teams and seasons they see', async function () {
      expect((await plays('', teammate)).ids).deep.equals([single])
      expect((await plays('', seasonFan)).ids).deep.equals([double])
      const hidden = await plays('', stranger)
      expect(hidden.status).equals(200)
      expect(hidden.ids).deep.equals([])
    })

    it('answers 404 for a user id that is not a number', async function () {
      if (db == null) return this.skip()
      expect((await ask('/players/usr_notanumber/plays')).status).equals(404)
    })
  })
})
