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
import { migration127AgeBands as migration } from './127ageBands'
import { migrations as all } from './index'

// Through this migration: those after it are another test's.
const migrations = all.slice(
  0,
  all.findIndex(m => m.name === migration.name) + 1
)

/**
 * Every account gets `is_adult` (false), `age_source` and `age_set_at`
 * (null), with `age_source` held to the four sources; and an `is_adult`
 * change re-checks the person's chats as a birth month does.
 */
describe('age bands migration', function () {
  this.timeout(120000)
  const name = `teamstation_age_bands_${process.pid}_${Date.now()}`
  const before126 = userIdOfValue((1n << 80n) + 1n)
  let admin: Pool
  let pool: Pool

  const dirty = async (): Promise<unknown[]> =>
    (
      await pool.query(
        `select distinct scope_type, scope_id from chat_dirty where scope_type = 'user' order by scope_id`
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
    await pool.query(
      `insert into users(id, display_name, birth_year, birth_month) values ($1, 'Demo Person', 2010, 4)`,
      [before126]
    )
    await migrateUp(pool, migrations)
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('gives an existing account no adult flag and no age source', async function () {
    const { rows } = await pool.query(
      'select is_adult, age_source, age_set_at, birth_year, birth_month from users where id = $1',
      [before126]
    )
    expect(rows).deep.equals([
      {
        is_adult: false,
        age_source: null,
        age_set_at: null,
        birth_year: 2010,
        birth_month: 4
      }
    ])
  })

  it('takes only the four age sources', async function () {
    for (const source of ['self', 'apple', 'guardian', 'admin']) {
      await pool.query('update users set age_source = $1 where id = $2', [
        source,
        before126
      ])
    }
    let failure: unknown
    try {
      await pool.query(`update users set age_source = 'coach' where id = $1`, [
        before126
      ])
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes('check constraint')
  })

  it('marks the person dirty when is_adult changes, and not for an unrelated change', async function () {
    await pool.query('delete from chat_dirty')
    await pool.query(
      `update users set display_name = 'Demo Renamed' where id = $1`,
      [before126]
    )
    expect(await dirty()).deep.equals([])
    await pool.query('update users set is_adult = true where id = $1', [
      before126
    ])
    expect(await dirty()).deep.equals([
      { scope_type: 'user', scope_id: before126 }
    ])
    await pool.query('delete from chat_dirty')
    await pool.query('update users set birth_month = 5 where id = $1', [
      before126
    ])
    expect(await dirty()).deep.equals([
      { scope_type: 'user', scope_id: before126 }
    ])
  })

  it('rolls back to the trigger that ignores is_adult', async function () {
    expect(await migrateDown(pool, migrations)).deep.equals([migration.name])
    const { rows } = await pool.query(
      `select column_name from information_schema.columns where table_name = 'users' and column_name in ('is_adult', 'age_source', 'age_set_at')`
    )
    expect(rows).deep.equals([])
    await pool.query('delete from chat_dirty')
    await pool.query('update users set birth_month = 6 where id = $1', [
      before126
    ])
    expect(await dirty()).deep.equals([
      { scope_type: 'user', scope_id: before126 }
    ])
    await migrateUp(pool, migrations)
  })
})
