import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateUp } from '../runner'
import {
  createMigratedDatabase,
  dropScratchDatabase,
  testDatabaseUrl,
  testDatabaseUrlOf
} from '../testDatabase'
import { migration116PitchingStrikes as migration } from './116pitchingStrikes'
import { migrations } from './index'

describe('pitching strikes historical rebuild', function () {
  this.timeout(60000)
  const name = `teamstation_pitch_strikes_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await createMigratedDatabase(
      admin,
      name,
      migrations.filter(m => m.name !== migration.name)
    )
    pool = new Pool({ connectionString: testDatabaseUrlOf(name) })
    await pool.query(`insert into teams(id,name) values ('tem_home','Valley Hawks'),('tem_away','Valley Owls');
      insert into games(id,home_team_id,away_team_id,start_at) values
      ('gam_pending','tem_home','tem_away',now()),('gam_new','tem_home','tem_away',now()),('gam_empty','tem_home','tem_away',now());
      insert into events(id,"gameId",gumbo) values
      ('evt_one','gam_pending','{"about":{"atBatIndex":0},"result":{"eventType":"game_advisory"}}'),
      ('evt_two','gam_new','{"about":{"atBatIndex":0},"result":{"eventType":"game_advisory"}}');
      insert into game_stats_state(game_id,requested_generation,built_generation,status,attempts,retry_at)
      values ('gam_pending',4,3,'failed',2,now());`)
  })
  after(async function () {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })
  it('requeues existing and unbuilt games once, retaining their built generation', async function () {
    await migrateUp(pool, migrations)
    const read = async (): Promise<unknown[]> =>
      (
        await pool.query(
          'select game_id, requested_generation::int, built_generation::int, status, attempts, retry_at from game_stats_state order by game_id'
        )
      ).rows
    const rows = await read()
    expect(rows).has.length(2)
    expect(rows[0]).includes({
      game_id: 'gam_new',
      requested_generation: 1,
      status: 'pending'
    })
    expect(rows[1]).includes({
      game_id: 'gam_pending',
      requested_generation: 5,
      built_generation: 3,
      status: 'pending',
      attempts: 0,
      retry_at: null
    })
    await migrateUp(pool, migrations)
    expect(await read()).deep.equals(rows)
  })
})
