import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../migrations'
import { migrateDown, migrateUp } from '../runner'
import { type SchemaSnapshot, schemaSnapshot } from '../schemaSnapshot'
import { testDatabaseUrl } from '../testDatabase'

describe('057 keys streams by device and keeps a phone’s recording', function () {
  this.timeout(60000)
  const name = `teamstation_phone_streams_${Date.now()}`
  const filmer = mintUserId(() => false)
  let admin: Pool
  let pool: Pool
  let before057: SchemaSnapshot

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '057phoneStreams')
    )
    before057 = await schemaSnapshot(pool)
    await pool.query(
      `insert into users (id, "legacyId", display_name) values ($1, $2, 'Clayton Kershaw')`,
      [filmer.userId, filmer.legacyId]
    )
    await pool.query(`
      insert into teams (id, name) values ('tem_home', 'Home'), ('tem_away', 'Away');
      insert into games (id, home_team_id, away_team_id, start_at)
        values ('gam_one', 'tem_home', 'tem_away', now());
    `)
    // A stream from before: a browser's, which has no device.
    await pool.query(
      `insert into live_streams (id, game_id, team_id, user_id, slot, label,
          key_hash, key_prefix, key_cipher, opens_at)
        values ('liv_before', 'gam_one', 'tem_home', $1, 1, 'Backstop',
          'hash_before', 'ts_before', 'cipher', now())`,
      [filmer.userId]
    )
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  const stream = async (
    id: string,
    slot: number,
    extra = ''
  ): Promise<void> => {
    await pool.query(
      `insert into live_streams (id, game_id, team_id, user_id, slot, label,
          key_hash, key_prefix, key_cipher, opens_at, device_id${extra === '' ? '' : ', closes_at'})
        values ($1, 'gam_one', 'tem_home', $2, $3, $4, $5, 'ts_x', 'cipher',
          now(), '00000000-0000-4000-8000-000000000001'${extra === '' ? '' : `, ${extra}`})`,
      [
        id,
        filmer.userId,
        slot,
        slot === 2 ? 'Home Plate' : 'home plate',
        `hash_${id}`
      ]
    )
  }

  const refusal = async (attempt: () => Promise<void>): Promise<string> => {
    let refused: unknown
    await attempt().catch((error: unknown) => {
      refused = error
    })
    return String(refused)
  }

  it('leaves every stream it finds as it was, with no device', async () => {
    expect((await migrateUp(pool, migrations)).applied).includes(
      '057phoneStreams'
    )
    const { rows } = await pool.query(
      `select device_id, device_model, local_recording, records_locally,
          director_claimed, label, slot from live_streams`
    )
    expect(rows).deep.equals([
      {
        device_id: null,
        device_model: null,
        local_recording: 'none',
        records_locally: false,
        director_claimed: false,
        label: 'Backstop',
        slot: 1
      }
    ])
  })

  it('keeps one active stream per device and camera name, in any case', async () => {
    await stream('liv_first', 2)
    expect(
      await refusal(async () => {
        await stream('liv_again', 3)
      })
    ).contains('live_streams_one_per_device_label')
    // Ended, the name is free again.
    await pool.query(
      `update live_streams set closes_at = now() where id = 'liv_first'`
    )
    await stream('liv_again', 3)
    expect(
      await refusal(async () => {
        await pool.query(
          `update live_streams set local_recording = 'kept' where id = 'liv_again'`
        )
      })
    ).contains('live_streams_local_recording_check')
  })

  it('links an upload to its stream, and a receipt to its dismissal', async () => {
    await pool.query(
      `insert into director_uploads (id, user_id, game_id, title, filename,
          size_bytes, part_size, live_stream_id)
        values ('dup_one', $1, 'gam_one', 'Home Plate', 'take.mp4', 10, 10,
          'liv_again')`,
      [filmer.userId]
    )
    const { rows } = await pool.query(
      `select live_stream_id, whole_stream from director_uploads`
    )
    expect(rows).deep.equals([
      { live_stream_id: 'liv_again', whole_stream: false }
    ])
    const { rows: receipts } = await pool.query(
      `select column_name, is_nullable from information_schema.columns
        where table_name = 'notification_receipts' and column_name = 'dismissed_at'`
    )
    expect(receipts).deep.equals([
      { column_name: 'dismissed_at', is_nullable: 'YES' }
    ])
  })

  it('rolls down to the earlier shape', async () => {
    expect(
      await migrateDown(
        pool,
        migrations,
        migrations.filter(m => m.name >= '057phoneStreams').length
      )
    ).includes('057phoneStreams')
    expect(await schemaSnapshot(pool)).deep.equals(before057)
    await migrateUp(pool, migrations)
  })
})
