import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { dropScratchDatabase, testDatabaseUrl } from '../testDatabase'
import { migration095SpentCodeNames } from './095spentCodeNames'
import { migrations } from './index'

/**
 * 095: a spent or expired sign-in code keeps no typed name, a pending one
 * keeps it, and the partial index issuing a code reads is there until the
 * migration is rolled back.
 */
describe('095 spent sign-in codes forget the typed name', function () {
  this.timeout(60000)
  const name = `teamstation_spent_code_names_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const before095 = migrations.filter(
    migration => migration.name < migration095SpentCodeNames.name
  )
  const through = migrations.filter(
    migration => migration.name <= migration095SpentCodeNames.name
  )
  let admin: Pool
  let pool: Pool

  const code = async (
    id: string,
    { consumed, expired }: { consumed: boolean; expired: boolean }
  ): Promise<void> => {
    await pool.query(
      `insert into email_codes
         (id, email, code_hash, purpose, expires_at, consumed_at, display_name)
       values ($1, $2, 'hash', 'login', $3, $4, 'Mike Trout')`,
      [
        id,
        `${id}@example.com`,
        new Date(Date.now() + (expired ? -60000 : 600000)),
        consumed ? new Date() : null
      ]
    )
  }
  const names = async (): Promise<Record<string, string | null>> =>
    Object.fromEntries(
      (
        await pool.query<{ id: string; display_name: string | null }>(
          'select id, display_name from email_codes order by id'
        )
      ).rows.map(row => [row.id, row.display_name])
    )
  const indexed = async (): Promise<boolean> =>
    (
      await pool.query(
        `select 1 from pg_indexes where indexname = 'email_codes_named_expiry'`
      )
    ).rows.length === 1

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, before095)
  })
  after(async function () {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('forgets the name on consumed and expired codes and keeps a pending one’s', async function () {
    await code('ecd_pending', { consumed: false, expired: false })
    await code('ecd_spent', { consumed: true, expired: false })
    await code('ecd_expired', { consumed: false, expired: true })
    await code('ecd_both', { consumed: true, expired: true })
    expect(await indexed()).equals(false)

    expect((await migrateUp(pool, through)).applied).deep.equals([
      '095spentCodeNames'
    ])
    expect(await names()).deep.equals({
      ecd_both: null,
      ecd_expired: null,
      ecd_pending: 'Mike Trout',
      ecd_spent: null
    })
    expect(await indexed()).equals(true)
  })

  it('drops the index on the way down and leaves the names as they are', async function () {
    await migrateDown(pool, through, 1)
    expect(await indexed()).equals(false)
    expect((await names()).ecd_pending).equals('Mike Trout')
    expect(
      (
        await pool.query(`select 1 from schema_migrations where name = $1`, [
          '095spentCodeNames'
        ])
      ).rows
    ).length(0)
  })
})
