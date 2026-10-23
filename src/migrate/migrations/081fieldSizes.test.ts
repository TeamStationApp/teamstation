import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { schemaSnapshot } from '../schemaSnapshot'
import { testDatabaseUrl } from '../testDatabase'
import { migration081FieldSizes } from './081fieldSizes'
import { migrations } from './index'

describe('081 field sizes', function () {
  this.timeout(60000)
  const name = `teamstation_fieldsizes_${process.pid}_${Date.now()}`
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
  const rollbackFailure = async (): Promise<string> => {
    let failure: unknown
    await migrateDown(pool, [migration081FieldSizes], 1).catch(
      (error: unknown) => {
        failure = error
      }
    )
    return String(failure)
  }
  const tBallField = `update venue_fields set sizes = '{T-ball,50/70}'`
  const tBallGame = `update games set field_id = 'fld_one', field_size = 'T-ball'`
  const tBallSeason = `insert into season_schedule_settings
    (season_id, field_size, game_minutes, buffer_minutes, regular_games,
     exhibition_games, doubleheaders, starts_on, ends_on)
    values ('sea_one', 'T-ball', 60, 10, 4, 0, 'never', '2027-03-01', '2027-05-31')`
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
      insert into leagues(id,name) values ('lea_one','Demo League');
      insert into seasons(id,name,year,league_id,starts_on,ends_on) values ('sea_one','Demo Season',2027,'lea_one','2027-03-01','2027-05-31');
      insert into games(id,home_team_id,away_team_id,start_at) values ('gam_one','tem_home','tem_away',now());
      insert into venues (id, google_place_id, name, latitude, longitude, timezone) values ('ven_one','place-one','Demo Park',40,-75,'UTC');
      insert into venue_fields (id, venue_id, name, sizes) values ('fld_one','ven_one','Field 1','{46/60}');`)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('refuses T-ball before it, and lets a field, a game and a season take it after', async () => {
    const narrow = await schemaSnapshot(pool)
    expect(await refused(tBallField)).includes('venue_fields_sizes_check')
    expect(await refused(tBallGame)).includes('games_field_size_check')
    expect(await refused(tBallSeason)).includes(
      'season_schedule_settings_field_size_check'
    )
    await migrateUp(pool, [migration081FieldSizes])
    await pool.query(tBallField)
    await pool.query(tBallGame)
    await pool.query(tBallSeason)
    expect(
      (
        await pool.query(
          `select (select sizes from venue_fields) as sizes,
            (select field_size from games) as game,
            (select field_size from season_schedule_settings) as season`
        )
      ).rows
    ).deep.equals([
      { sizes: ['T-ball', '50/70'], game: 'T-ball', season: 'T-ball' }
    ])
    // 46/60 stays a size of its own, and other sizes are still refused.
    await pool.query(`update venue_fields set sizes = '{T-ball,46/60}'`)
    expect(
      await refused(`update venue_fields set sizes = '{T-ball,70/100}'`)
    ).includes('venue_fields_sizes_check')
    expect(await refused(`update venue_fields set sizes = '{}'`)).includes(
      'venue_fields_sizes_check'
    )
    expect(await refused(`update games set field_size = 'Tee ball'`)).includes(
      'games_field_size_check'
    )

    // Each use of T-ball on its own refuses the rollback.
    expect(await rollbackFailure()).includes('use the T-ball size')
    await pool.query(`update venue_fields set sizes = '{46/60}'`)
    expect(await rollbackFailure()).includes('use the T-ball size')
    await pool.query(`update games set field_size = '46/60'`)
    expect(await rollbackFailure()).includes('use the T-ball size')
    await pool.query(`update season_schedule_settings set field_size = '46/60'`)

    await migrateDown(pool, [migration081FieldSizes], 1)
    expect(await schemaSnapshot(pool)).deep.equals(narrow)
    expect(await refused(tBallField)).includes('venue_fields_sizes_check')
    expect((await pool.query(`select field_size from games`)).rows).deep.equals(
      [{ field_size: '46/60' }]
    )
    await migrateUp(pool, [migration081FieldSizes])
  })
})
