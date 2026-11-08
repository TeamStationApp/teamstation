import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { dropScratchDatabase, testDatabaseUrl } from '../testDatabase'
import { migration114GamePlans } from './114gamePlans'
import { migrations } from './index'

/** 114: one game plan per team in a game, gone with the game. */
describe('114 game plans', function () {
  this.timeout(60000)
  const name = `teamstation_game_plans_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const through = migrations.filter(
    migration => migration.name <= migration114GamePlans.name
  )
  let admin: Pool
  let pool: Pool

  const tables = async (): Promise<string[]> =>
    (
      await pool.query<{ table_name: string }>(
        `select table_name from information_schema.tables
          where table_name = 'game_plans'`
      )
    ).rows.map(row => row.table_name)
  const plan = async (
    gameId: string,
    teamId: string,
    innings: number
  ): Promise<void> => {
    await pool.query(
      `insert into game_plans (game_id, team_id, innings, rows)
         values ($1, $2, $3, $4)`,
      [gameId, teamId, innings, JSON.stringify([])]
    )
  }

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, through.slice(0, -1))
    await pool.query(`
      insert into teams (id, name) values ('tem_hawks', 'Hawks'), ('tem_owls', 'Owls');
      insert into games (id, home_team_id, away_team_id, start_at)
        values ('gam_one', 'tem_hawks', 'tem_owls', '2027-04-03T17:00:00Z'),
               ('gam_two', 'tem_owls', 'tem_hawks', '2027-04-10T17:00:00Z')`)
  })
  after(async function () {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('creates game_plans, one per team in a game, off until enabled', async function () {
    expect(await tables()).deep.equals([])
    await migrateUp(pool, through)
    expect(await tables()).deep.equals(['game_plans'])
    await plan('gam_one', 'tem_hawks', 6)
    await plan('gam_one', 'tem_owls', 12)
    await plan('gam_two', 'tem_hawks', 1)
    const { rows } = await pool.query(
      `select game_id, team_id, enabled, innings, rows, updated_by,
              updated_at is not null as stamped
         from game_plans order by game_id, team_id`
    )
    expect(rows).deep.equals([
      {
        game_id: 'gam_one',
        team_id: 'tem_hawks',
        enabled: false,
        innings: 6,
        rows: [],
        updated_by: null,
        stamped: true
      },
      {
        game_id: 'gam_one',
        team_id: 'tem_owls',
        enabled: false,
        innings: 12,
        rows: [],
        updated_by: null,
        stamped: true
      },
      {
        game_id: 'gam_two',
        team_id: 'tem_hawks',
        enabled: false,
        innings: 1,
        rows: [],
        updated_by: null,
        stamped: true
      }
    ])
    // A team has one plan in a game.
    let duplicate: unknown
    try {
      await plan('gam_one', 'tem_hawks', 6)
    } catch (error) {
      duplicate = error
    }
    expect((duplicate as { code?: string }).code).equals('23505')
  })

  it('holds 1 to 12 innings', async function () {
    for (const innings of [0, 13]) {
      let refused: unknown
      try {
        await plan('gam_two', 'tem_owls', innings)
      } catch (error) {
        refused = error
      }
      expect((refused as { code?: string }).code, `${innings}`).equals('23514')
    }
  })

  it('names a team that exists, and goes with its game', async function () {
    let unknown: unknown
    try {
      await plan('gam_two', 'tem_nobody', 6)
    } catch (error) {
      unknown = error
    }
    expect((unknown as { code?: string }).code).equals('23503')
    await pool.query(`delete from games where id = 'gam_one'`)
    const { rows } = await pool.query(
      `select game_id, team_id from game_plans order by game_id`
    )
    expect(rows).deep.equals([{ game_id: 'gam_two', team_id: 'tem_hawks' }])
  })

  it('drops the table on the way down', async function () {
    expect(await migrateDown(pool, through, 1)).deep.equals([
      migration114GamePlans.name
    ])
    expect(await tables()).deep.equals([])
    expect(
      (await pool.query(`select id from games order by id`)).rows
    ).deep.equals([{ id: 'gam_two' }])
  })
})
