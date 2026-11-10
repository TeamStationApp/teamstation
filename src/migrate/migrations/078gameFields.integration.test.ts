import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration078GameFields } from './078gameFields'
import { migrations } from './index'

describe('078 game fields', function () {
  this.timeout(60000)
  const name = `teamstation_gamefields_${process.pid}_${Date.now()}`
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
      migrations.filter(m => m.name < '078')
    )
    await pool.query(`insert into teams(id,name) values ('tem_home','Hosts'),('tem_away','Visitors');
      insert into games(id,home_team_id,away_team_id,start_at) values ('gam_one','tem_home','tem_away',now());
      insert into venues (id, google_place_id, name, latitude, longitude, timezone) values ('ven_one','place-one','Demo Park',40,-75,'UTC');
      insert into venue_fields (id, venue_id, name, sizes) values ('fld_one','ven_one','Field 1','{50/70}');`)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('links games to fields, both or neither, and rolls back while none is linked', async () => {
    await migrateUp(pool, [migration078GameFields])
    expect(
      (await pool.query(`select field_id, field_size from games`)).rows
    ).deep.equals([{ field_id: null, field_size: null }])
    expect(await refused(`update games set field_id = 'fld_one'`)).includes(
      'games_field_and_size'
    )
    expect(
      await refused(
        `update games set field_id = 'fld_one', field_size = '70/100'`
      )
    ).includes('check')
    expect(
      await refused(
        `update games set field_id = 'fld_missing', field_size = '50/70'`
      )
    ).includes('foreign key')
    await migrateDown(pool, [migration078GameFields], 1)
    await migrateUp(pool, [migration078GameFields])
  })
  it('remembers a warning once, and drops it with its game', async () => {
    await pool.query(
      `update games set field_id = 'fld_one', field_size = '50/70'`
    )
    await pool.query(
      `insert into game_field_warnings (game_id, kind) values ('gam_one', 'fieldDeleted')`
    )
    expect(
      await refused(
        `insert into game_field_warnings (game_id, kind) values ('gam_one', 'fieldDeleted')`
      )
    ).includes('duplicate key')
    await pool.query(
      `insert into game_field_warnings (game_id, kind, other_ref) values ('gam_one', 'conflict', 'gam_two')`
    )
    expect(
      await refused(
        `insert into game_field_warnings (game_id, kind) values ('gam_one', 'flooded')`
      )
    ).includes('check')
    let failure: unknown
    try {
      await migrateDown(pool, [migration078GameFields], 1)
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes('Games are linked to fields')
    await pool.query(`delete from games`)
    expect(
      (await pool.query(`select count(*)::int as n from game_field_warnings`))
        .rows[0].n
    ).equals(0)
  })
})
