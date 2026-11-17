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
import { migration125SolverLimit as migration } from './125solverLimit'
import { migrations as all } from './index'

// Up to this one: a later migration would be the one rolled back.
const migrations = all.slice(0, all.indexOf(migration) + 1)

describe('the solver limit and proven previews', function () {
  this.timeout(60000)
  const name = `teamstation_solver_limit_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  const columns = async (): Promise<string[]> =>
    (
      await pool.query<{ name: string }>(
        `select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable as name
         from information_schema.columns
         where (table_name, column_name) in (('league_schedule_setups', 'solver_limit_ms'), ('schedule_previews', 'proven_optimal'))
         order by 1`
      )
    ).rows.map(row => row.name)
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
  it('adds both columns, nullable, keeps a limit positive, and takes them away again', async function () {
    expect(await columns()).deep.equals([])
    await migrateUp(pool, migrations)
    expect(await columns()).deep.equals([
      'league_schedule_setups.solver_limit_ms integer YES',
      'schedule_previews.proven_optimal boolean YES'
    ])
    await pool.query(
      `insert into leagues (id, name, created_at, updated_at) values ('lea_limit', 'Limit League', now(), now());
       insert into league_schedule_setups (league_id) values ('lea_limit')`
    )
    const { rows } = await pool.query(
      `select solver_limit_ms from league_schedule_setups where league_id = 'lea_limit'`
    )
    expect(rows).deep.equals([{ solver_limit_ms: null }])
    let refused = ''
    try {
      await pool.query(
        `update league_schedule_setups set solver_limit_ms = 0 where league_id = 'lea_limit'`
      )
    } catch (error) {
      refused = String(error)
    }
    expect(refused).includes('check constraint')
    expect(await migrateDown(pool, migrations)).deep.equals([migration.name])
    expect(await columns()).deep.equals([])
  })
})
