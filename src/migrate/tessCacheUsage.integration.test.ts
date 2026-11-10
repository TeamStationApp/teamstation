import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from './migrations'
import { migration106TessCacheUsage } from './migrations/106tessCacheUsage'
import { migrateUp } from './runner'
import { testDatabaseUrl } from './testDatabase'

const ADDED = [
  ['tess_changes', 'details'],
  ['tess_conversations', 'turn_client_id'],
  ['tess_conversations', 'turn_stop'],
  ['tess_usage_weeks', 'cache_read_tokens'],
  ['tess_usage_weeks', 'cache_write_tokens']
]

describe('Tess cache usage migration', function () {
  this.timeout(120000)
  const name = `teamstation_tesscache_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool

  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(pool, migrations)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  const columns = async (): Promise<string[][]> =>
    (
      await pool.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where (table_name, column_name) in (${ADDED.map(
           (_, at) => `($${at * 2 + 1}, $${at * 2 + 2})`
         ).join(', ')})
         order by table_name, column_name`,
        ADDED.flat()
      )
    ).rows.map(row => [row.table_name, row.column_name])

  it('adds the cache counts at zero for weeks already kept, and goes back down', async () => {
    expect(await columns()).deep.equals(ADDED)
    await pool.query(migration106TessCacheUsage.down)
    expect(await columns()).deep.equals([])
    await pool.query(migration106TessCacheUsage.up)
    expect(await columns()).deep.equals(ADDED)
    const { rows } = await pool.query<{ column_default: string }>(
      `select column_default from information_schema.columns
       where table_name = 'tess_usage_weeks' and column_name like 'cache_%'`
    )
    expect(rows.map(row => row.column_default)).deep.equals(['0', '0'])
  })
})
