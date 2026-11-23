import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfValue } from '../../common/userId'
import { migrateDown, migrateUp } from '../runner'
import {
  createMigratedDatabase,
  dropScratchDatabase,
  testDatabaseUrl,
  testDatabaseUrlOf
} from '../testDatabase'
import { migration129DropChatAgeConfirmations as migration } from './129dropChatAgeConfirmations'
import { migrations as all } from './index'

// Through this migration: those after it are another test's.
const migrations = all.slice(
  0,
  all.findIndex(m => m.name === migration.name) + 1
)

/** The 13-or-older confirmation columns go, and come back empty going down. */
describe('dropping the chat age confirmations', function () {
  this.timeout(120000)
  const name = `teamstation_drop_chat_age_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool

  const column = async (): Promise<unknown[]> =>
    (
      await pool.query(
        `select column_name from information_schema.columns where table_name = 'users' and column_name like 'chat_age_%' order by 1`
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

  it('drops both columns with their rows, and brings them back empty', async function () {
    const demo = userIdOfValue((1n << 80n) + 3n)
    const both = [
      { column_name: 'chat_age_confirmed_at' },
      { column_name: 'chat_age_source' }
    ]
    expect(await column()).deep.equals(both)
    await pool.query(
      `insert into users(id, display_name, chat_age_confirmed_at, chat_age_source) values ($1, 'Demo Person', now(), 'self')`,
      [demo]
    )
    await migrateUp(pool, migrations)
    expect(await column()).deep.equals([])
    expect(await migrateDown(pool, migrations)).deep.equals([migration.name])
    expect(await column()).deep.equals(both)
    const { rows } = await pool.query(
      `select chat_age_confirmed_at, chat_age_source from users where id = $1`,
      [demo]
    )
    expect(rows).deep.equals([
      { chat_age_confirmed_at: null, chat_age_source: null }
    ])
  })
})
