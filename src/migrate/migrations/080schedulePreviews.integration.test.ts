import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration080SchedulePreviews } from './080schedulePreviews'
import { migrations } from './index'

describe('080 schedule previews', function () {
  this.timeout(60000)
  const name = `teamstation_schedulepreviews_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  const refused = async (statement: string): Promise<string> => {
    let failure: unknown
    await pool.query(statement).catch((error: unknown) => {
      failure = error
    })
    expect(failure, statement).not.equals(undefined)
    return String(failure)
  }
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '080')
    )
    await pool.query(`insert into teams(id,name) values ('tem_home','Hosts'),('tem_away','Visitors');
      insert into leagues(id,name) values ('lea_one','Demo League');
      insert into seasons(id,name,year,league_id,starts_on,ends_on) values ('sea_one','Demo Season',2027,'lea_one','2027-03-01','2027-05-31');
      insert into games(id,home_team_id,away_team_id,start_at) values ('gam_one','tem_home','tem_away',now());`)
    await pool.query(
      `insert into users(id, display_name) values ($1, 'Demo Planner')`,
      [userIdOfGumbo(4242)]
    )
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('keeps previews and their published games, and rolls back only while there are none', async () => {
    await migrateUp(pool, [migration080SchedulePreviews])
    const planner = (
      await pool.query<{ id: string }>(
        `select id from users order by id limit 1`
      )
    ).rows[0].id
    const preview = (status: string, publishedAt: string): string =>
      `insert into schedule_previews (id, league_id, created_by, mode, input, status, published_at)
        values ('spv_${status}', 'lea_one', '${planner}', 'full', '{}', '${status}', ${publishedAt})`
    expect(await refused(preview('published', 'null'))).includes(
      'schedule_previews_published'
    )
    expect(await refused(preview('open', 'now()'))).includes(
      'schedule_previews_published'
    )
    expect(
      await refused(
        `insert into schedule_previews (id, league_id, created_by, mode, input) values ('spv_x', 'lea_one', '${planner}', 'some', '{}')`
      )
    ).includes('check')
    await pool.query(preview('open', 'null'))
    expect(
      (
        await pool.query(
          `select options, edits, status, blocking from schedule_previews`
        )
      ).rows
    ).deep.equals([{ options: [], edits: {}, status: 'open', blocking: null }])
    await pool.query(`insert into schedule_preview_games
      (preview_id, game_key, season_id, home_team_id, away_team_id, game_id)
      values ('spv_open', 'game-1', 'sea_one', 'tem_home', 'tem_away', 'gam_one')`)
    expect(
      await refused(`insert into schedule_preview_games
        (preview_id, game_key, season_id, home_team_id, away_team_id)
        values ('spv_open', 'game-1', 'sea_one', 'tem_home', 'tem_away')`)
    ).includes('duplicate key')
    await pool.query(
      `update games set schedule_preview_id = 'spv_open' where id = 'gam_one'`
    )
    // A deleted game leaves its row, with no game.
    await pool.query(
      `update games set schedule_preview_id = null; delete from games`
    )
    expect(
      (await pool.query(`select game_id from schedule_preview_games`)).rows
    ).deep.equals([{ game_id: null }])
    let failure: unknown
    await migrateDown(pool, [migration080SchedulePreviews], 1).catch(
      (error: unknown) => {
        failure = error
      }
    )
    expect(String(failure)).includes('Schedules have been previewed')
    await pool.query(
      `delete from schedule_preview_games; delete from schedule_previews`
    )
    await migrateDown(pool, [migration080SchedulePreviews], 1)
    await migrateUp(pool, [migration080SchedulePreviews])
  })
})
