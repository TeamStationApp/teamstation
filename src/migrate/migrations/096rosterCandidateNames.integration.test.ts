import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration096RosterCandidateNames } from './096rosterCandidateNames'
import { migrations } from './index'

describe('096 roster candidate names', function () {
  this.timeout(60000)
  const name = `teamstation_candidatenames_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  const indexes = async (): Promise<string[]> =>
    (
      await pool.query<{ indexname: string }>(
        `select indexname from pg_indexes
          where tablename = 'users' and indexname like 'users_%_fold'
          order by indexname`
      )
    ).rows.map(row => row.indexname)
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '089')
    )
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('folds names for a prefix search, indexes all three, and rolls back', async () => {
    await migrateUp(pool, [migration096RosterCandidateNames])
    expect(await indexes()).deep.equals([
      'users_display_name_fold',
      'users_first_name_fold',
      'users_last_name_fold'
    ])
    const folded = await pool.query<{ a: string; b: string; c: string }>(
      `select ts_name_fold('José Ramírez') as a, ts_name_fold(null) as b,
              ts_name_fold('ÉLLY') as c`
    )
    expect(folded.rows[0]).deep.equals({ a: 'jose ramirez', b: '', c: 'elly' })
    const volatility = await pool.query<{ provolatile: string }>(
      `select provolatile from pg_proc where proname = 'ts_name_fold'`
    )
    expect(volatility.rows[0].provolatile).equals('i')
    // The planner can serve a typed prefix from the index.
    await pool.query(`set enable_seqscan = off`)
    const plan = await pool.query<{ 'QUERY PLAN': string }>(
      `explain select id from users
        where ts_name_fold(last_name) like ts_name_fold('bet') || '%'`
    )
    expect(plan.rows.map(row => row['QUERY PLAN']).join('\n')).includes(
      'users_last_name_fold'
    )
    await pool.query(`reset enable_seqscan`)

    await migrateDown(pool, [migration096RosterCandidateNames], 1)
    expect(await indexes()).deep.equals([])
    const fold = await pool.query(
      `select 1 from pg_proc where proname = 'ts_name_fold'`
    )
    expect(fold.rowCount).equals(0)
  })
})
