import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../server/users/mintUserId'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration098StreamManagement } from './098streamManagement'
import { migrations } from './index'

describe('098 stream management', function () {
  this.timeout(60000)
  const name = `teamstation_streammanagement_${process.pid}_${Date.now()}`
  const USER = mintUserId()
  let admin: Pool
  let pool: Pool
  const camera = (
    id: string,
    slot: number,
    state: string,
    extra: { recording?: string; label?: string; device?: string } = {}
  ): string =>
    `insert into live_streams
       (id, game_id, team_id, user_id, slot, label, key_hash, key_prefix,
        key_cipher, state, opens_at, created_at, updated_at, local_recording,
        device_id)
     values ('${id}', 'gam_one', 'tem_home', '${USER}', ${slot},
             ${extra.label == null ? 'null' : `'${extra.label}'`},
             'hash_${id}', 'ts_', 'v1.a.b.c', '${state}', now(), now(), now(),
             '${extra.recording ?? 'none'}',
             ${extra.device == null ? 'null' : `'${extra.device}'`})`
  const rejection = async (statement: string): Promise<string> => {
    let caught: unknown
    await pool.query(statement).catch((error: unknown) => {
      caught = error
    })
    expect(caught, statement).not.equals(undefined)
    return String(caught)
  }
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '098')
    )
    await pool.query(`insert into users (id, display_name) values ('${USER}', 'Mookie Betts');
      insert into teams (id, name) values ('tem_home', 'Hosts'), ('tem_away', 'Visitors');
      insert into games (id, home_team_id, away_team_id, start_at) values ('gam_one', 'tem_home', 'tem_away', now());`)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  const refusal = async (): Promise<string> => {
    let refused: unknown
    await migrateDown(pool, [migration098StreamManagement], 1).catch(
      (error: unknown) => {
        refused = error
      }
    )
    return String(refused)
  }

  it('applies over an uploaded row with a later row in its slot, and refuses to roll back over them', async () => {
    await pool.query(
      camera('liv_uploaded', 1, 'revoked', { recording: 'uploaded' })
    )
    await pool.query(camera('liv_later', 1, 'idle'))
    await migrateUp(pool, [migration098StreamManagement])

    const { rows } = await pool.query(
      `select state, closes_at from live_streams where id = 'liv_uploaded'`
    )
    expect(rows[0].state).equals('ended')
    expect(rows[0].closes_at).not.equals(null)

    expect(await refusal()).includes('Cameras share a slot or a device label')
    await pool.query(`delete from live_streams where id = 'liv_uploaded'`)
  })

  it('holds a slot and a name for active rows only', async () => {
    expect(await rejection(camera('liv_clash', 1, 'idle'))).includes(
      'live_streams_one_per_slot'
    )
    await pool.query(
      camera('liv_phone', 2, 'idle', { label: 'Home', device: 'dev_1' })
    )
    expect(
      await rejection(
        camera('liv_name', 3, 'idle', { label: 'HOME', device: 'dev_1' })
      )
    ).includes('live_streams_one_per_device_label')

    await pool.query(
      `update live_streams set closes_at = now() where id = 'liv_phone'`
    )
    await pool.query(
      camera('liv_name', 2, 'idle', { label: 'HOME', device: 'dev_1' })
    )
  })

  it('refuses to roll back while two rows share a device label, and rolls back once none do', async () => {
    await pool.query(`delete from live_streams where id = 'liv_phone'`)
    await pool.query(
      camera('liv_phone', 3, 'ended', { label: 'Home', device: 'dev_1' })
    )
    expect(await refusal()).includes('Cameras share a slot or a device label')

    await pool.query(
      `update live_streams set state = 'revoked' where id = 'liv_phone'`
    )
    await migrateDown(pool, [migration098StreamManagement], 1)

    const { rows } = await pool.query(
      `select column_name from information_schema.columns
        where table_name = 'live_streams'
          and column_name in ('source', 'discarded_at')`
    )
    expect(rows).deep.equals([])
    expect(await rejection(camera('liv_clash', 1, 'ended'))).includes(
      'live_streams_one_per_slot'
    )
  })
})
