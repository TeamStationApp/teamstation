import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrateDown, migrateUp } from '../runner'
import { schemaSnapshot } from '../schemaSnapshot'
import { testDatabaseUrl } from '../testDatabase'
import { migrations as allMigrations } from './index'
const migrations = allMigrations.filter(m => m.name <= '074optionalUmpires')

describe('optional umpire migration', function () {
  this.timeout(60000)
  const name = `optional_schema_${process.pid}_${Date.now()}`
  let admin: Pool, pool: Pool
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '074optionalUmpires')
    )
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('preserves existing requirements and assignments and safely reverses and reapplies', async () => {
    await pool.query(`insert into users(id,first_name,display_name) values ('${userIdOfGumbo(101)}','Demo','Demo Umpire');
      insert into leagues(id,name) values ('lea_demo','Demo League');
      insert into teams(id,name) values ('tem_home','Demo Home'),('tem_away','Demo Away');
      insert into seasons(id,name,league_id,year,starts_on,ends_on) values ('sea_demo','Demo Season','lea_demo',2027,'2027-01-01','2027-12-31');
      insert into games(id,home_team_id,away_team_id,season_id,start_at) values ('gam_demo','tem_home','tem_away','sea_demo','2027-04-01');
      insert into umpire_levels(id,league_id,name,position) values ('ulv_demo','lea_demo','Demo',0);
      insert into season_umpire_requirements values ('sea_demo','ulv_demo',true,2);
      insert into umpire_assignments(game_id,slot,user_id,assigned_by) values ('gam_demo','field:2','${userIdOfGumbo(101)}','${userIdOfGumbo(101)}');`)
    const snapshot = await schemaSnapshot(pool)
    const held = (await pool.query('select * from umpire_assignments')).rows
    await migrateUp(pool, migrations)
    expect(
      (
        await pool.query(
          'select optional_field_count from season_umpire_requirements'
        )
      ).rows[0].optional_field_count
    ).equals(0)
    expect(
      (await pool.query('select * from umpire_assignments')).rows
    ).deep.equals(held)
    await pool.query("update umpire_assignments set slot='field:12'")
    let refused = false
    try {
      await migrateDown(pool, migrations, 1)
    } catch {
      refused = true
    }
    expect(refused).equals(true)
    expect(
      (await pool.query('select slot from umpire_assignments')).rows[0].slot
    ).equals('field:12')
    await pool.query("update umpire_assignments set slot='field:2'")
    await migrateDown(pool, migrations, 1)
    expect(await schemaSnapshot(pool)).deep.equals(snapshot)
    await migrateUp(pool, migrations)
    expect(
      (
        await pool.query(
          'select optional_field_count from season_umpire_requirements'
        )
      ).rows[0].optional_field_count
    ).equals(0)
  })
})
