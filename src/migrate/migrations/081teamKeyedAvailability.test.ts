import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration081TeamKeyedAvailability } from './081teamKeyedAvailability'
import { migrations } from './index'

describe('081 team-keyed availability', function () {
  this.timeout(60000)
  const name = `teamstation_teamkeyed_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  const lists = async (
    id: string
  ): Promise<{ guests: unknown; unrostered: unknown }> =>
    (
      await pool.query('select guests, unrostered from games where id = $1', [
        id
      ])
    ).rows[0]
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '081')
    )
    await pool.query(`insert into teams(id,name) values ('tem_home','Hosts'),('tem_away','Visitors');
      insert into games(id,home_team_id,away_team_id,start_at,guests,unrostered)
        values ('gam_lists','tem_home','tem_away',now(),'{"away":[7],"home":[8,9]}','{"away":[],"home":[3]}'),
               ('gam_empty','tem_home','tem_away',now(),default,default);`)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('keys each list by its team, and back by side', async () => {
    await migrateUp(pool, [migration081TeamKeyedAvailability])
    expect(await lists('gam_lists')).deep.equals({
      guests: { tem_away: [7], tem_home: [8, 9] },
      unrostered: { tem_away: [], tem_home: [3] }
    })
    expect(await lists('gam_empty')).deep.equals({
      guests: { tem_away: [], tem_home: [] },
      unrostered: { tem_away: [], tem_home: [] }
    })
    await pool.query(
      `insert into games(id,home_team_id,away_team_id,start_at) values ('gam_new','tem_home','tem_away',now())`
    )
    expect(await lists('gam_new')).deep.equals({ guests: {}, unrostered: {} })

    await migrateDown(pool, [migration081TeamKeyedAvailability])
    expect(await lists('gam_lists')).deep.equals({
      guests: { away: [7], home: [8, 9] },
      unrostered: { away: [], home: [3] }
    })
    expect(await lists('gam_new')).deep.equals({
      guests: { away: [], home: [] },
      unrostered: { away: [], home: [] }
    })
  })
})
