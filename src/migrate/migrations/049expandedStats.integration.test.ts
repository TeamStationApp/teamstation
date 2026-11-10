import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../test/historicalUserIds'
import { migrations as allMigrations } from '../migrations'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'

const statsMigrations = allMigrations.filter(
  migration => migration.name <= '049expandedStats'
)

// Exercise this historical migration independently of later identity changes.
const migrations = allMigrations.filter(m => m.name <= '049expandedStats')

describe('049 expanded statistics migration', function () {
  this.timeout(60000)
  const name = `teamstation_expandedstats_migration_${Date.now()}`
  const person = mintUserId(() => false)
  let admin: Pool
  let pool: Pool
  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '049expandedStats')
    )
    await pool.query(
      `insert into users(id, "legacyId", display_name) values ($1, $2, 'Demo Batter')`,
      [person.userId, person.legacyId]
    )
    await pool.query(`insert into teams(id,name) values ('tem_home','Demo Hawks'), ('tem_away','Demo Owls');
      insert into games(id,home_team_id,away_team_id,start_at) values ('gam_pending','tem_home','tem_away',now()), ('gam_new','tem_home','tem_away',now()), ('gam_empty','tem_home','tem_away',now());
      insert into events(id,"gameId",gumbo) values ('evt_one','gam_pending','{"about":{"atBatIndex":0},"result":{"eventType":"game_advisory"}}'), ('evt_two','gam_new','{"about":{"atBatIndex":0},"result":{"eventType":"game_advisory"}}');
      insert into game_stats_state(game_id,requested_generation,built_generation,status,attempts,retry_at) values ('gam_pending',4,3,'failed',2,now());`)
    await pool.query(
      `insert into game_player_stats(id,game_id,user_id,team_id,pa) values ('gps_demo','gam_pending',$1,'tem_home',2)`,
      [person.userId]
    )
  })
  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('preserves old counts and requeues existing and new games with events', async function () {
    expect((await migrateUp(pool, statsMigrations)).applied).deep.equals([
      '049expandedStats'
    ])
    const row = (await pool.query('select pa,extra from game_player_stats'))
      .rows[0]
    expect(row).deep.equals({ pa: 2, extra: null })
    const rows = (
      await pool.query(
        'select game_id,requested_generation,built_generation,status,attempts,retry_at from game_stats_state order by game_id'
      )
    ).rows
    expect(rows).has.length(2)
    expect(Number(rows[0].requested_generation)).equals(1)
    expect(Number(rows[1].requested_generation)).equals(5)
    expect(Number(rows[1].built_generation)).equals(3)
    expect(rows[1]).includes({ status: 'pending', attempts: 0, retry_at: null })
  })
  it('rolls down and up without removing existing counts or queue generations', async function () {
    expect(await migrateDown(pool, statsMigrations)).deep.equals([
      '049expandedStats'
    ])
    expect(
      (
        await pool.query(
          "select column_name from information_schema.columns where table_name='game_player_stats' and column_name='extra'"
        )
      ).rows
    ).has.length(0)
    await migrateUp(pool, statsMigrations)
    expect(
      Number(
        (
          await pool.query(
            "select requested_generation from game_stats_state where game_id='gam_pending'"
          )
        ).rows[0].requested_generation
      )
    ).equals(6)
    expect(
      (await pool.query('select pa from game_player_stats')).rows[0].pa
    ).equals(2)
  })
})
