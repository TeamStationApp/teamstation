import { expect } from 'chai'
import express from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import type { Database } from '../db/database'
import { statsRoutes } from './stats'

// One player's figures, asked for the way the page asks for them.
//
// The filter is the thing a reader touches, so it is the thing under test: a
// season, a team, a year, a career, and the answer a filter that matches
// nothing gives. The rows are written straight into `game_player_stats`
// because what is being tested is the reading of them: the counting belongs
// to the stats engine that writes them.

const adminUrl =
  process.env.GS_TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres'
const scratchName = `gamestation_statsroute_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const spring = makeId('season')
const fall = makeId('season')
const hawks = makeId('team')
const ravens = makeId('team')
const jordan = makeId('user')
const jordanClosed = makeId('user')
const stranger = makeId('user')

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
      headers: { 'x-test-actor': actor }
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
        { id: spring, name: 'Spring 2026', year: 2026, innings_per_game: 6 },
        { id: fall, name: 'Fall 2025', year: 2025, innings_per_game: 6 }
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
        { id: jordan, display_name: 'Jordan Pujols' },
        // The same child, on another team, closed into the row above.
        {
          id: jordanClosed,
          display_name: 'Jordan Pujols',
          merged_into: jordan
        },
        { id: stranger, display_name: 'Somebody Else' }
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
      if (id != null) req.actor = { userId: id, isAdmin: false, tokenId: null }
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
})
