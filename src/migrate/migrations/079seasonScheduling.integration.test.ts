import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration079SeasonScheduling } from './079seasonScheduling'
import { migrations } from './index'

describe('079 season scheduling', function () {
  this.timeout(60000)
  const name = `teamstation_seasonscheduling_${process.pid}_${Date.now()}`
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
  const settings = (): string =>
    `insert into season_schedule_settings (season_id, field_size, game_minutes, buffer_minutes, regular_games, exhibition_games, doubleheaders, starts_on, ends_on)
      values ('sea_one', '50/70', 90, 10, 4, 1, 'never', '2027-03-01', '2027-05-31')`
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '079')
    )
    await pool.query(`insert into teams(id,name) values ('tem_one','Hosts');
      insert into leagues(id,name) values ('lea_one','Demo League');
      insert into seasons(id,name,year,league_id,starts_on,ends_on) values ('sea_one','Demo Season',2027,'lea_one','2027-03-01','2027-05-31');`)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('holds flags, settings and setups, checked, and rolls back only while empty', async () => {
    await migrateUp(pool, [migration079SeasonScheduling])
    await pool.query(
      `insert into season_team_flags (season_id, team_id) values ('sea_one', 'tem_one')`
    )
    expect(
      (await pool.query(`select exhibition from season_team_flags`)).rows
    ).deep.equals([{ exhibition: false }])
    expect(
      await refused(
        `insert into season_team_flags (season_id, team_id) values ('sea_one', 'tem_one')`
      )
    ).includes('duplicate key')
    expect(
      await refused(
        `insert into season_team_flags (season_id, team_id) values ('sea_missing', 'tem_one')`
      )
    ).includes('foreign key')
    for (const [from, to, message] of [
      [`'50/70'`, `'70/100'`, 'check'],
      ['90,', '25,', 'check'],
      ['10,', '300,', 'check'],
      [`'never'`, `'sometimes'`, 'check'],
      [`'2027-05-31'`, `'2027-02-01'`, 'season_schedule_settings_dates']
    ])
      expect(await refused(settings().replace(from, to))).includes(message)
    await pool.query(settings())
    expect(
      (
        await pool.query(
          `select blackouts, windows from season_schedule_settings`
        )
      ).rows
    ).deep.equals([{ blackouts: [], windows: [] }])
    await pool.query(
      `insert into league_schedule_setups (league_id) values ('lea_one')`
    )
    expect(
      (
        await pool.query(
          `select season_ids, field_ids from league_schedule_setups`
        )
      ).rows
    ).deep.equals([{ season_ids: [], field_ids: [] }])
    let failure: unknown
    await migrateDown(pool, [migration079SeasonScheduling], 1).catch(
      (error: unknown) => {
        failure = error
      }
    )
    expect(String(failure)).includes('Seasons have scheduling settings')
    await pool.query(
      `delete from season_schedule_settings; delete from league_schedule_setups`
    )
    // Rows that flag nothing are no reason to keep the tables.
    await migrateDown(pool, [migration079SeasonScheduling], 1)
    await migrateUp(pool, [migration079SeasonScheduling])
  })
})
