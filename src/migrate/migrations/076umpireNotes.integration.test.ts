import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { schemaSnapshot } from '../schemaSnapshot'
import { testDatabaseUrl } from '../testDatabase'
import { migrations as allMigrations } from './index'
const migrations = allMigrations.filter(m => m.name <= '076umpireNotes')

describe('custom umpire notes migration', function () {
  this.timeout(60000)
  const name = `notes_schema_${process.pid}_${Date.now()}`
  let admin: Pool, pool: Pool
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '076umpireNotes')
    )
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('adds constrained note tables and reverses without changing existing schema', async () => {
    const before = await schemaSnapshot(pool)
    await migrateUp(pool, migrations)
    await pool.query(
      `insert into leagues(id,name) values ('lea_notes','Demo League'); insert into umpire_note_types values ('unt_notes','lea_notes','Jersey Color',0);`
    )
    let duplicate = false
    try {
      await pool.query(
        `insert into umpire_note_types values ('unt_other','lea_notes','JERSEY COLOR',1)`
      )
    } catch {
      duplicate = true
    }
    expect(duplicate).equals(true)
    await migrateDown(pool, migrations, 1)
    expect(await schemaSnapshot(pool)).deep.equals(before)
    await migrateUp(pool, migrations)
  })
})
