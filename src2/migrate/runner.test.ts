import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from './migrations'
import { BASELINE, migrateDown, migrateUp } from './runner'
import { testDatabaseUrl } from './testDatabase'

/**
 * Runs the real migrations against a scratch database, so the SQL itself is
 * tested and not just the runner's bookkeeping. Postgres 18 on port 5433 is
 * required; a closed port fails the suite.
 */
const adminUrl = testDatabaseUrl
const scratchName = `gamestation_test_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

describe('migrations', function () {
  this.timeout(60000)

  let admin: Pool
  let pool: Pool

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query('select 1')
    await admin.query(`create database ${scratchName}`)
    pool = new Pool({ connectionString: scratchUrl })
  })

  after(async function () {
    if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  it('refuses a server older than Postgres 18 before it runs anything', async function () {
    const asked: string[] = []
    const old = {
      query: async (text: string) => {
        asked.push(text)
        return { rows: [{ server_version_num: '160015' }] }
      }
    } as unknown as Pool
    const refused = await migrateUp(old, migrations).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(refused)
      .instanceOf(Error)
      .property('message')
      .equals(
        'Postgres 16 is too old: the migrations need Postgres 18 or later ' +
          '(server_version_num 160015)'
      )
    expect(asked).deep.equals(['show server_version_num'])
  })

  it('applies every migration, then reports them as already applied', async function () {
    const first = await migrateUp(pool, migrations)
    expect(first.applied).deep.equals(migrations.map(item => item.name))
    expect(first.alreadyApplied).deep.equals([])

    const second = await migrateUp(pool, migrations)
    expect(second.applied).deep.equals([])
    expect(second.alreadyApplied.length).equals(migrations.length)
  })

  it('creates the tables the app expects', async function () {
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
      'system_settings',
      'invites',
      'invite_redemptions',
      'league_members'
    ]) {
      expect(names.has(table), `missing table ${table}`).equals(true)
    }
  })

  it('seeds the highlight timing settings', async function () {
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
    const rolledBack = await migrateDown(pool, migrations, migrations.length)
    expect(rolledBack.length).equals(migrations.length)

    const { rows } = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public'"
    )
    expect(rows.map(row => row.tablename)).deep.equals(['schema_migrations'])
  })

  it('applies cleanly a second time after a rollback', async function () {
    const again = await migrateUp(pool, migrations)
    expect(again.applied).deep.equals(migrations.map(item => item.name))
  })

  it('migrates up again after rolling back below the baseline', async function () {
    const rolledBack = await migrateDown(pool, migrations, 2)
    expect(rolledBack[rolledBack.length - 1]).equals(BASELINE)
    const again = await migrateUp(pool, migrations)
    expect(again.applied).deep.equals([...rolledBack].reverse())
  })
})

describe('the baseline', function () {
  this.timeout(60000)

  const name = `gamestation_baseline_${Date.now()}`
  let admin: Pool
  let pool: Pool

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: adminUrl.replace(/\/[^/]*$/, `/${name}`)
    })
  })

  after(async function () {
    if (pool != null) await pool.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  it('refuses a database with history from before the rewrite, and touches nothing', async function () {
    const early = migrations.filter(migration => migration.name < '031')
    await migrateUp(pool, early)
    await pool.query(`insert into schema_migrations (name) values ('016x')`)
    const tablesBefore = await pool.query<{ count: string }>(
      "select count(*) from pg_tables where schemaname = 'public'"
    )

    const refused = await migrateUp(pool, migrations).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(refused)
      .instanceOf(Error)
      .property('message')
      .equals(
        `${name} predates ${BASELINE}: migrations before it were rewritten ` +
          'for empty databases; restore a production dump instead'
      )
    const { rows } = await pool.query<{ count: string }>(
      'select count(*) from schema_migrations'
    )
    expect(rows[0].count).equals(String(early.length + 1))
    const tablesAfter = await pool.query<{ count: string }>(
      "select count(*) from pg_tables where schemaname = 'public'"
    )
    expect(tablesAfter.rows[0].count).equals(tablesBefore.rows[0].count)
  })

  it('does not guard a list that stops short of the baseline', async function () {
    const short = migrations.filter(migration => migration.name < '032')
    const result = await migrateUp(pool, short)
    expect(result.applied).deep.equals(['031scoring'])
  })
})
