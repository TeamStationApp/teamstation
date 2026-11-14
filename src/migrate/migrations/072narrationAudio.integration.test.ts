import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../migrations'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'

describe('060 keeps the announcer’s spoken sentences', function () {
  this.timeout(60000)
  const name = `teamstation_narration_audio_${Date.now()}`
  let admin: Pool
  let pool: Pool

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '072narrationAudio')
    )
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  // Up to and including it: the later account cutover (075) cannot be
  // reversed, so a roll down from the latest would stop there.
  const throughIt = migrations.filter(m => m.name <= '072narrationAudio')

  const table = async (): Promise<string | null> =>
    (
      await pool.query<{ name: string | null }>(
        "select to_regclass('narration_audio')::text as name"
      )
    ).rows[0].name

  it('adds the table, one row per digest', async function () {
    expect(await table()).equals(null)
    expect((await migrateUp(pool, throughIt)).applied).includes(
      '072narrationAudio'
    )
    await pool.query(
      `insert into narration_audio (digest, text, voice, audio)
        values ('d1', 'Ball one, one and oh.', 'rex', '\\xfff3'::bytea)`
    )
    const twice = await pool
      .query(
        `insert into narration_audio (digest, text, voice, audio)
          values ('d1', 'Ball one, one and oh.', 'rex', '\\xfff3'::bytea)`
      )
      .catch((error: unknown) => error)
    expect(String(twice)).contains('narration_audio_pkey')
    const row = (
      await pool.query<{ created_at: Date }>(
        'select created_at from narration_audio'
      )
    ).rows[0]
    expect(row.created_at).instanceOf(Date)
  })

  it('rolls down by dropping it', async function () {
    expect(await migrateDown(pool, throughIt, 1)).includes('072narrationAudio')
    expect(await table()).equals(null)
  })
})
