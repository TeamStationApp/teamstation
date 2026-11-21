import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import {
  createMigratedDatabase,
  dropScratchDatabase,
  testDatabaseUrl,
  testDatabaseUrlOf
} from '../testDatabase'
import { migration128ChatHiddenHistory as migration } from './128chatHiddenHistory'
import { migrations } from './index'

/** Every DM member gets a `hidden_before`, null until a rule sets it. */
describe('chat hidden history migration', function () {
  this.timeout(120000)
  const name = `teamstation_chat_hidden_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool

  const column = async (): Promise<unknown[]> =>
    (
      await pool.query(
        `select data_type, is_nullable from information_schema.columns where table_name = 'chat_members' and column_name = 'hidden_before'`
      )
    ).rows

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await createMigratedDatabase(
      admin,
      name,
      migrations.filter(m => m.name !== migration.name)
    )
    pool = new Pool({ connectionString: testDatabaseUrlOf(name) })
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('adds a nullable time to every member, and takes it away again', async function () {
    expect(await column()).deep.equals([])
    await migrateUp(pool, migrations)
    expect(await column()).deep.equals([
      { data_type: 'timestamp with time zone', is_nullable: 'YES' }
    ])
    expect(await migrateDown(pool, migrations)).deep.equals([migration.name])
    expect(await column()).deep.equals([])
  })
})
