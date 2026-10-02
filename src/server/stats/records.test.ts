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
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { errorHandler } from '../middleware/withErrors'
import { eventRoutes } from '../routes/events'
import { seasonRoutes } from '../routes/seasons'
import { statsRoutes } from '../routes/stats'
import { teamRoutes } from '../routes/teams'
import { teamRecords } from './records'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_records_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const spring = makeId('season')
const fall = makeId('season')
const eagles = makeId('team')
const hawks = makeId('team')
const owls = makeId('team')
const idle = makeId('team')
const made = mintUserId(() => false)
const viewer = made.userId

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
  },
  workDir: '/tmp'
}

type Status = 'scheduled' | 'inProgress' | 'final'

describe('team records, read from the games', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined
  let base = ''
  let server: ReturnType<express.Express['listen']> | undefined
  let day = 0

  async function game(
    home: string,
    away: string,
    seasonId: string | null,
    status: Status,
    homeScore: number | null,
    awayScore: number | null
  ): Promise<string> {
    const id = makeId('game')
    day += 1
    await db!
      .insertInto('games')
      .values({
        id,
        home_team_id: home,
        away_team_id: away,
        season_id: seasonId,
        start_at: new Date(Date.UTC(2026, 3, day)),
        status,
        home_score: homeScore,
        away_score: awayScore
      })
      .execute()
    return id
  }

  const ask = async (path: string): Promise<any> => {
    const res = await fetch(`${base}${path}`, {
      headers: { 'x-test-actor': String(viewer) }
    })
    expect(res.status, path).equals(200)
    return await res.json()
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

    const now = new Date()
    await db
      .insertInto('users')
      .values({
        id: viewer,
        legacyId: made.legacyId,
        display_name: 'Viewer View',
        first_name: 'Viewer',
        last_name: 'View',
        is_admin: true,
        created_at: now,
        updated_at: now
      })
      .execute()
    await db
      .insertInto('seasons')
      .values([
        { id: spring, name: 'Spring', year: 2026 },
        { id: fall, name: 'Fall', year: 2025 }
      ])
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: eagles, name: 'Eagles' },
        { id: hawks, name: 'Hawks' },
        { id: owls, name: 'Owls' },
        { id: idle, name: 'Idle' }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values(
        [eagles, hawks, owls, idle].map(teamId => ({
          season_id: spring,
          team_id: teamId
        }))
      )
      .execute()

    // Spring: Eagles beat Hawks at home, Hawks beat Eagles away, Eagles and
    // Owls tie. Fall: Eagles lose to Owls. One season-less final. Then games
    // that must not count.
    await game(eagles, hawks, spring, 'final', 5, 2)
    await game(eagles, hawks, spring, 'final', 1, 3)
    await game(owls, eagles, spring, 'final', 4, 4)
    await game(owls, eagles, fall, 'final', 6, 0)
    await game(hawks, owls, null, 'final', 2, 1)
    await game(eagles, owls, spring, 'scheduled', null, null)
    await game(eagles, owls, spring, 'inProgress', 3, 1)
    await game(eagles, owls, spring, 'final', null, 2)

    const app = express()
    app.use(jsonBody)
    app.use((req, _res, next) => {
      const id = req.header('x-test-actor')
      if (id != null) {
        req.actor = { userId: asUserId(id), isAdmin: true, tokenId: null }
      }
      next()
    })
    app.use('/api/v1', teamRoutes(db, media))
    app.use('/api/v1', seasonRoutes(db, media))
    app.use('/api/v1', statsRoutes(db))
    app.use('/api/v1', eventRoutes(db))
    app.use(errorHandler)
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

  describe('teamRecords', function () {
    it('counts wins, losses, ties and runs from both sides of a game', async function () {
      const rows = await teamRecords(db!, { seasonId: spring })
      const of = (teamId: string): unknown =>
        rows.find(row => row.teamId === teamId)
      expect(of(eagles)).deep.equals({
        teamId: eagles,
        seasonId: spring,
        w: 1,
        l: 1,
        t: 1,
        runsFor: 10,
        runsAgainst: 9
      })
      expect(of(hawks)).deep.equals({
        teamId: hawks,
        seasonId: spring,
        w: 1,
        l: 1,
        t: 0,
        runsFor: 5,
        runsAgainst: 6
      })
      expect(of(owls)).deep.equals({
        teamId: owls,
        seasonId: spring,
        w: 0,
        l: 0,
        t: 1,
        runsFor: 4,
        runsAgainst: 4
      })
    })

    it('leaves out games that are not final, or final without both scores', async function () {
      const rows = await teamRecords(db!, {
        teamIds: [owls],
        seasonId: spring
      })
      expect(rows.map(row => [row.w, row.l, row.t])).deep.equals([[0, 0, 1]])
    })

    it('keeps one row per season, and a season-less row apart', async function () {
      const rows = await teamRecords(db!, { teamIds: [eagles] })
      const text = (a: string | null, b: string | null): number =>
        (a ?? '').localeCompare(b ?? '')
      expect(rows.map(row => row.seasonId).sort(text)).deep.equals(
        [spring, fall].sort(text)
      )
      const none = await teamRecords(db!, { seasonId: null })
      expect(
        none
          .map(row => `${row.teamId} ${row.w}-${row.l}`)
          .sort((a, b) => a.localeCompare(b))
      ).deep.equals(
        [`${hawks} 1-0`, `${owls} 0-1`].sort((a, b) => a.localeCompare(b))
      )
      expect(none.every(row => row.seasonId == null)).equals(true)
    })

    it('filters by team, answers nobody for an empty list, and has no row for a team that never finished a game', async function () {
      expect(await teamRecords(db!, { teamIds: [] })).deep.equals([])
      expect(await teamRecords(db!, { teamIds: [idle] })).deep.equals([])
      const two = await teamRecords(db!, {
        teamIds: [hawks, owls],
        seasonId: spring
      })
      expect(
        two.map(row => row.teamId).sort((a, b) => a.localeCompare(b))
      ).deep.equals([hawks, owls].sort((a, b) => a.localeCompare(b)))
    })
  })

  describe('the routes that show a record', function () {
    it('gives each team on /teams its newest season’s record', async function () {
      const teams: Array<{ id: string; record: any }> = await ask('/teams')
      const eaglesRow = teams.find(team => team.id === eagles)
      expect(eaglesRow?.record).deep.equals({
        w: 1,
        l: 1,
        t: 1,
        seasonName: 'Spring'
      })
      expect(teams.find(team => team.id === idle)?.record).equals(null)
    })

    it('gives each side of a game its record in that game’s season', async function () {
      const gameId = await game(hawks, eagles, spring, 'scheduled', null, null)
      const body = await ask(`/games/${gameId}`)
      expect(body.homeRecord).equals('1–1')
      expect(body.awayRecord).equals('1–1–1')
    })

    it('shows a record on the season’s team list, and none for a team with no finished game', async function () {
      const teams: Array<{ id: string; record: any }> = await ask(
        `/seasons/${spring}/teams`
      )
      expect(teams.find(team => team.id === hawks)?.record).deep.equals({
        w: 1,
        l: 1,
        t: 0,
        seasonName: null
      })
      expect(teams.find(team => team.id === idle)?.record).equals(null)
    })

    it('sorts the standings by winning percentage, then run differential', async function () {
      const table: Array<{ teamId: string; teamName: string }> = await ask(
        `/seasons/${spring}/standings`
      )
      // A tie is a game played: Hawks .500, Eagles .333, Owls .000.
      expect(table.map(row => row.teamName)).deep.equals([
        'Hawks',
        'Eagles',
        'Owls'
      ])
    })

    it('breaks a tie in winning percentage on run differential', async function () {
      const summer = makeId('season')
      const [p, q, r, s] = ['P', 'Q', 'R', 'S'].map(() => makeId('team'))
      await db!
        .insertInto('seasons')
        .values({ id: summer, name: 'Summer', year: 2024 })
        .execute()
      await db!
        .insertInto('teams')
        .values([
          { id: p, name: 'P' },
          { id: q, name: 'Q' },
          { id: r, name: 'R' },
          { id: s, name: 'S' }
        ])
        .execute()
      await db!
        .insertInto('season_teams')
        .values(
          [p, q, r, s].map(teamId => ({ season_id: summer, team_id: teamId }))
        )
        .execute()
      // P and R both 1–0, P by ten and R by one; S and Q both 0–1.
      await game(p, q, summer, 'final', 10, 0)
      await game(r, s, summer, 'final', 2, 1)
      const table: Array<{ teamName: string }> = await ask(
        `/seasons/${summer}/standings`
      )
      expect(table.map(row => row.teamName)).deep.equals(['P', 'R', 'S', 'Q'])
    })

    /** Posts one play that ends the game with this score, as a scorer does. */
    async function postFinal(
      gameId: string,
      homeScore: number,
      awayScore: number
    ): Promise<void> {
      const res = await fetch(`${base}/games/${gameId}/events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-actor': String(viewer)
        },
        body: JSON.stringify({
          plays: [
            {
              about: { atBatIndex: 0 },
              result: { eventType: 'final_score', awayScore, homeScore }
            }
          ],
          source: { system: 'teamstation' }
        })
      })
      expect(res.status).equals(200)
    }

    it('moves every record the moment a posted game becomes final', async function () {
      const gameId = await game(hawks, owls, spring, 'scheduled', null, null)
      await postFinal(gameId, 9, 1)

      const page = await ask(`/games/${gameId}`)
      expect(page.homeRecord).equals('2–1')
      expect(page.awayRecord).equals('0–1–1')

      const table: Array<{ teamName: string; w: number; l: number }> =
        await ask(`/seasons/${spring}/standings`)
      expect(table[0]).deep.include({ teamName: 'Hawks', w: 2, l: 1 })
      const teams: Array<{ id: string; record: any }> = await ask(
        `/seasons/${spring}/teams`
      )
      expect(teams.find(team => team.id === owls)?.record).deep.include({
        w: 0,
        l: 1,
        t: 1
      })
      const listed: Array<{ id: string; record: any }> = await ask('/teams')
      expect(listed.find(team => team.id === hawks)?.record).deep.include({
        w: 2,
        l: 1
      })
    })

    it('reorders the standings when a later game is posted', async function () {
      const before: Array<{ teamName: string }> = await ask(
        `/seasons/${spring}/standings`
      )
      // Hawks .667, Eagles .333, Owls .000.
      expect(before.map(row => row.teamName)).deep.equals([
        'Hawks',
        'Eagles',
        'Owls'
      ])
      const gameId = await game(owls, eagles, spring, 'scheduled', null, null)
      await postFinal(gameId, 6, 0)
      // Owls 1–1–1 is .333 and Eagles 1–2–1 is .250.
      const after: Array<{ teamName: string }> = await ask(
        `/seasons/${spring}/standings`
      )
      expect(after.map(row => row.teamName)).deep.equals([
        'Hawks',
        'Owls',
        'Eagles'
      ])
    })
  })
})
