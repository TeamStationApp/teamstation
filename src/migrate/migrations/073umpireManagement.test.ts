import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { type SchemaSnapshot, schemaSnapshot } from '../schemaSnapshot'
import { testDatabaseUrl } from '../testDatabase'
import { migrations as allMigrations } from './index'

const migrations = allMigrations.filter(m => m.name <= '073umpireManagement')
describe('073umpireManagement schema', function () {
  this.timeout(60000)
  const name = `umpire_schema_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  let snapshot: SchemaSnapshot
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '073umpireManagement')
    )
    snapshot = await schemaSnapshot(pool)
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('creates independent tables and reverses to the exact prior schema', async () => {
    await migrateUp(pool, migrations)
    for (const table of [
      'league_umpires',
      'umpire_levels',
      'season_umpire_requirements',
      'umpire_certifications',
      'umpire_assignments'
    ])
      expect(
        (await pool.query('select to_regclass($1)::text as name', [table]))
          .rows[0].name
      ).equals(table)
    await migrateDown(pool, migrations, 1)
    expect(await schemaSnapshot(pool)).deep.equals(snapshot)
  })
})
