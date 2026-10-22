import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrateDown, migrateUp } from '../runner'
import { schemaSnapshot } from '../schemaSnapshot'
import { testDatabaseUrl } from '../testDatabase'
import { migrations as allMigrations } from './index'
const migrations = allMigrations.filter(m => m.name <= '075umpireTypes')

describe('configurable umpire migration', function () {
  this.timeout(60000)
  const name = `types_schema_${process.pid}_${Date.now()}`
  let admin: Pool, pool: Pool
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '075umpireTypes')
    )
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('preserves populated positions, certifications and counts and refuses lossy rollback atomically', async () => {
    const user = userIdOfGumbo(101)
    await pool.query(`insert into users(id,first_name,display_name) values ('${user}','Demo','Demo Umpire');
      insert into leagues(id,name) values ('lea_demo','Demo League');
      insert into teams(id,name) values ('tem_home','Demo Home'),('tem_away','Demo Away');
      insert into seasons(id,name,league_id,year,starts_on,ends_on) values ('sea_demo','Demo Season','lea_demo',2027,'2027-01-01','2027-12-31');
      insert into games(id,home_team_id,away_team_id,season_id,start_at) values ('gam_demo','tem_home','tem_away','sea_demo','2027-04-01');
      insert into umpire_levels(id,league_id,name,position) values ('ulv_demo','lea_demo','Demo',0);
      insert into season_umpire_requirements values ('sea_demo','ulv_demo',true,2,2);
      insert into umpire_certifications values ('${user}','ulv_demo',true,false);
      insert into umpire_assignments(game_id,slot,user_id,assigned_by) values ('gam_demo','field:4','${user}','${user}');`)
    const snapshot = await schemaSnapshot(pool)
    const old = (await pool.query('select * from umpire_assignments')).rows
    await migrateUp(pool, migrations)
    expect(
      (
        await pool.query('select name from umpire_types order by position')
      ).rows.map(r => r.name)
    ).deep.equals(['Plate', 'Field'])
    expect(
      (
        await pool.query(
          "select required_count,optional_count from season_umpire_type_requirements r join umpire_types t on t.id=r.type_id where t.name='Field'"
        )
      ).rows[0]
    ).deep.equals({ required_count: 2, optional_count: 2 })
    expect(
      (
        await pool.query(
          'select enabled from umpire_certifications c join umpire_types t on t.id=c.type_id order by t.position'
        )
      ).rows.map(r => r.enabled)
    ).deep.equals([true, false])
    const typed = (await pool.query('select slot from umpire_assignments'))
      .rows[0].slot
    expect(typed).matches(/^uty_.*:4$/)
    await pool.query(
      "insert into umpire_types(id,league_id,name,position) values ('uty_custom','lea_demo','1st',2)"
    )
    let refused = false
    try {
      await migrateDown(pool, migrations, 1)
    } catch {
      refused = true
    }
    expect(refused).equals(true)
    expect(
      (await pool.query('select slot from umpire_assignments')).rows[0].slot
    ).equals(typed)
    await pool.query("delete from umpire_types where id='uty_custom'")
    await migrateDown(pool, migrations, 1)
    expect(
      (await pool.query('select * from umpire_assignments')).rows
    ).deep.equals(old)
    expect(await schemaSnapshot(pool)).deep.equals(snapshot)
    await migrateUp(pool, migrations)
  })
})
