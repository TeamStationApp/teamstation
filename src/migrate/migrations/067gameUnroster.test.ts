import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration067GameUnroster } from './067gameUnroster'
import { migrations } from './index'

describe('067 game unroster', function () {
  this.timeout(60000)
  const name = `teamstation_unroster_${process.pid}_${Date.now()}`
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
      migrations.filter(m => m.name < '067')
    )
    await pool.query(`insert into teams(id,name) values ('tem_home','Hosts'),('tem_away','Visitors');
      insert into games(id,home_team_id,away_team_id,start_at) values ('gam_before','tem_home','tem_away',now());`)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('defaults both existing and new games to independent empty lists and rejects null', async () => {
    await migrateUp(pool, [migration067GameUnroster])
    await pool.query(
      `insert into games(id,home_team_id,away_team_id,start_at) values ('gam_after','tem_home','tem_away',now())`
    )
    expect(
      (await pool.query('select unrostered from games order by id')).rows
    ).deep.equals([
      { unrostered: { away: [], home: [] } },
      { unrostered: { away: [], home: [] } }
    ])
    await pool.query(
      `update games set unrostered='{"away":[123],"home":[]}' where id='gam_before'`
    )
    expect(
      (await pool.query(`select unrostered from games where id='gam_after'`))
        .rows[0].unrostered
    ).deep.equals({ away: [], home: [] })
    let refused: unknown
    await pool.query(`update games set unrostered=null`).catch(error => {
      refused = error
    })
    expect(String(refused)).includes('not-null constraint')
  })
  it('drops only the new column on down', async () => {
    await migrateDown(pool, [migration067GameUnroster], 1)
    expect(
      (
        await pool.query(
          `select column_name from information_schema.columns where table_name='games' and column_name='unrostered'`
        )
      ).rows
    ).deep.equals([])
    expect(
      (await pool.query('select count(*)::int as n from games')).rows[0].n
    ).equals(2)
  })
})
