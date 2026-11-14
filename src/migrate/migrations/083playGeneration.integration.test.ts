import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration083PlayGeneration } from './083playGeneration'
import { migration084GamePlayArchives } from './084gamePlayArchives'
import { migrations } from './index'

describe('083 play generation and 084 game play archives', function () {
  this.timeout(60000)
  const name = `teamstation_generation_${process.pid}_${Date.now()}`
  const scorer = userIdOfGumbo(7001)
  let admin: Pool
  let pool: Pool
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '083')
    )
    await pool.query(`insert into teams(id,name) values ('tem_home','Hosts'),('tem_away','Visitors');
      insert into users(id,display_name) values ('${scorer}','Scorer');
      insert into games(id,home_team_id,away_team_id,start_at)
        values ('gam_old','tem_home','tem_away',now());`)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  it('starts every game on generation 0, and drops the column on the way down', async () => {
    await migrateUp(pool, [migration083PlayGeneration])
    const generation = async (): Promise<unknown> =>
      (
        await pool.query(
          `select play_generation from games where id = 'gam_old'`
        )
      ).rows[0].play_generation
    expect(await generation()).equals(0)
    await migrateDown(pool, [migration083PlayGeneration])
    const columns = await pool.query(
      `select 1 from information_schema.columns where table_name = 'games' and column_name = 'play_generation'`
    )
    expect(columns.rowCount).equals(0)
    await migrateUp(pool, [migration083PlayGeneration])
  })

  it("keeps a reset's archive until its game is deleted, and past its scorer's", async () => {
    await migrateUp(pool, [migration084GamePlayArchives])
    await pool.query(`insert into game_play_archives
        (id, game_id, actor_user_id, reason, home_team_id, away_team_id, status,
         play_generation, plays, players, tags)
      values ('gpa_one', 'gam_old', '${scorer}', 'resetSwap', 'tem_home', 'tem_away',
        'inProgress', 0, '[]', '[]', '[]')`)
    await pool.query(`delete from users where id = $1`, [scorer])
    const kept = await pool.query(
      `select actor_user_id from game_play_archives where id = 'gpa_one'`
    )
    expect(kept.rows).deep.equals([{ actor_user_id: null }])
    await pool.query(`delete from games where id = 'gam_old'`)
    expect(
      (await pool.query(`select 1 from game_play_archives`)).rowCount
    ).equals(0)
    await migrateDown(pool, [migration084GamePlayArchives])
    const table = await pool.query(
      `select to_regclass('game_play_archives') as t`
    )
    expect(table.rows[0].t).equals(null)
  })
})
