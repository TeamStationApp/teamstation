import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from './migrations'
import { migrateDown, migrateUp } from './runner'

/**
 * Runs the real migrations against a scratch database, so the SQL itself is
 * tested and not just the runner's bookkeeping. If no Postgres is reachable
 * the suite skips rather than fails, because a laptop without one should
 * still be able to run the rest of the tests.
 */
const adminUrl =
  process.env.GS_TEST_DATABASE_URL ?? 'postgres://localhost:5432/postgres'
const scratchName = `gamestation_test_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('migrations', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let reachable = false

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
      reachable = true
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
  })

  after(async function () {
    if (pool != null) await pool.end()
    if (admin != null) {
      if (reachable) await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('applies every migration, then reports them as already applied', async function () {
    if (pool == null) this.skip()
    const first = await migrateUp(pool, migrations)
    expect(first.applied).deep.equals(migrations.map(item => item.name))
    expect(first.alreadyApplied).deep.equals([])

    const second = await migrateUp(pool, migrations)
    expect(second.applied).deep.equals([])
    expect(second.alreadyApplied.length).equals(migrations.length)
  })

  it('creates the tables the app expects', async function () {
    if (pool == null) this.skip()
    const { rows } = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'"
    )
    const names = new Set(rows.map(row => row.tablename))
    for (const table of [
      'users',
      'teams',
      'leagues',
      'seasons',
      'season_teams',
      'memberships',
      'games',
      'videos',
      'events',
      'event_players',
      'audit_log',
      'system_settings'
    ]) {
      expect(names.has(table), `missing table ${table}`).equals(true)
    }
  })

  it('seeds the highlight timing settings', async function () {
    if (pool == null) this.skip()
    const { rows } = await pool.query<{ key: string; value: unknown }>(
      'select key, value from system_settings order by key'
    )
    const keys = rows.map(row => row.key)
    expect(keys).deep.equals(
      [
        'highlights.lagSec',
        'highlights.leadSecByEventType',
        'highlights.leadSec'
      ].sort()
    )
  })

  it('rolls every migration back, leaving only its own bookkeeping', async function () {
    if (pool == null) this.skip()
    const rolledBack = await migrateDown(pool, migrations, migrations.length)
    expect(rolledBack.length).equals(migrations.length)

    const { rows } = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'"
    )
    expect(rows.map(row => row.tablename)).deep.equals(['schema_migrations'])
  })

  it('applies cleanly a second time after a rollback', async function () {
    if (pool == null) this.skip()
    const again = await migrateUp(pool, migrations)
    expect(again.applied).deep.equals(migrations.map(item => item.name))
  })
})
