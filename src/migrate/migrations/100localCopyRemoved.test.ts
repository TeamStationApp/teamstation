import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../server/users/mintUserId'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration100LocalCopyRemoved } from './100localCopyRemoved'
import { migrations } from './index'

describe('100 local copy removed', function () {
  this.timeout(60000)
  const name = `teamstation_localcopyremoved_${process.pid}_${Date.now()}`
  const USER = mintUserId()
  let admin: Pool
  let pool: Pool
  const failure = async (statement: string): Promise<string> => {
    let caught: unknown
    await pool.query(statement).catch((error: unknown) => {
      caught = error
    })
    expect(caught, statement).not.equals(undefined)
    return String(caught)
  }
  const stateOf = async (id: string): Promise<string> =>
    (
      await pool.query(
        `select local_recording from live_streams where id = '${id}'`
      )
    ).rows[0].local_recording
  const camera = (id: string, slot: number): string =>
    `insert into live_streams
       (id, game_id, team_id, user_id, slot, key_hash, key_prefix, key_cipher,
        state, opens_at, created_at, updated_at, local_recording)
     values ('${id}', 'gam_one', 'tem_home', '${USER}', ${slot}, 'hash_${id}',
             'ts_', 'v1.a.b.c', 'ended', now(), now(), now(), 'recorded')`
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '100')
    )
    await pool.query(`insert into users (id, display_name) values ('${USER}', 'Mookie Betts');
      insert into teams (id, name) values ('tem_home', 'Hosts'), ('tem_away', 'Visitors');
      insert into games (id, home_team_id, away_team_id, start_at) values ('gam_one', 'tem_home', 'tem_away', now());`)
    await pool.query(camera('liv_one', 1))
    await pool.query(camera('liv_two', 2))
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('takes removed, and rolls back to none', async function () {
    const remove = `update live_streams set local_recording = 'removed' where id = 'liv_one'`
    expect(await failure(remove)).includes('live_streams_local_recording_check')

    await migrateUp(pool, [migration100LocalCopyRemoved])
    await pool.query(remove)
    expect(await stateOf('liv_one')).equals('removed')

    await migrateDown(pool, [migration100LocalCopyRemoved], 1)
    expect(await stateOf('liv_one')).equals('none')
    expect(await stateOf('liv_two')).equals('recorded')
    expect(await failure(remove)).includes('live_streams_local_recording_check')
  })
})
