import { expect } from 'chai'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { REPLAY_TEAMS } from '../../test/replayGameFixture'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { battingLines, pitchingLines } from '../stats'
import { statRows } from '../stats/rows'
import {
  mintToken,
  nineInningActions,
  seedStatsTables,
  STATS_TABLES_SEED,
  type StatsTablesSeed
} from './statsTablesSeed'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_statstablesseed_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('stats tables seed', function () {
  this.timeout(120000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database> | undefined
  let seeded: StatsTablesSeed

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
    const clock = (): Date => new Date('2026-09-26T17:00:00Z')
    await seedStatsTables(db, { clock })
    // A second run rebuilds what it owns rather than doubling it.
    seeded = await seedStatsTables(db, { clock })
  })

  after(async function () {
    if (db != null) await db.destroy()
    else if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('gives the player lines for three teams, two of them called Hawks', async function () {
    const rows = await statRows(db!, { userId: seeded.playerId })
    const teams = new Set(rows.map(row => row.teamId))
    for (const team of [
      STATS_TABLES_SEED.teams.hawksSpring,
      STATS_TABLES_SEED.teams.hawksFall,
      STATS_TABLES_SEED.teams.ravens,
      REPLAY_TEAMS.home.id
    ])
      expect(teams.has(team), team).equals(true)
    const names = await db!
      .selectFrom('teams')
      .select('name')
      .where('id', 'in', [
        STATS_TABLES_SEED.teams.hawksSpring,
        STATS_TABLES_SEED.teams.hawksFall
      ])
      .execute()
    expect(names.map(team => team.name)).deep.equals(['Hawks', 'Hawks'])
    // Summer 2024 is a stored row with no line, so it is offered and empty.
    const summer = rows.filter(
      row => row.seasonId === STATS_TABLES_SEED.seasons.summer
    )
    expect(summer).length(1)
    expect(battingLines(summer)).deep.equals([])
    expect(pitchingLines(summer)).deep.equals([])
  })

  it('scores nine innings and leaves the game going, the home side ahead', async function () {
    const game = await db!
      .selectFrom('games')
      .select(['linescore', 'status'])
      .where('id', '=', STATS_TABLES_SEED.nineInnings)
      .executeTakeFirstOrThrow()
    const line = game.linescore as {
      away: { runs: number[] }
      home: { runs: number[] }
    }
    expect(game.status).not.equals('final')
    expect(line.away.runs).deep.equals([0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(line.home.runs.slice(0, 8)).deep.equals([0, 0, 1, 0, 0, 0, 0, 0])
    expect(
      nineInningActions().some(
        action => action.type === 'gameFlow' && action.kind === 'endGame'
      )
    ).equals(false)
  })

  it('signs in a site administrator who coaches the box score’s home side', async function () {
    const reader = await db!
      .selectFrom('users')
      .select(['is_admin', 'login_enabled'])
      .where('id', '=', seeded.readerId)
      .executeTakeFirstOrThrow()
    expect(reader).deep.equals({ is_admin: true, login_enabled: true })
    const roles = await db!
      .selectFrom('scope_roles')
      .select(['scope_id', 'role'])
      .where('user_id', '=', seeded.readerId)
      .execute()
    expect(roles).deep.equals([{ scope_id: seeded.coachTeam, role: 'coach' }])
    expect(seeded.token).to.be.a('string')
    // A new token is a new sign-in code, and the earlier one is spent.
    expect(await mintToken(db!)).not.equals(seeded.token)
  })
})
