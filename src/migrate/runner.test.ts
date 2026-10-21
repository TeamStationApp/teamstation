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
const scratchName = `teamstation_test_${Date.now()}`
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
        'highlights.leadSec',
        'mail.accountMessages'
      ].sort()
    )
  })

  it('rolls back the reversible suffix and refuses reverse identity migrations', async () => {
    const before = (
      await pool.query('select name from schema_migrations order by name')
    ).rows
    let failure: unknown
    try {
      await migrateDown(pool, migrations, migrations.length)
    } catch (error) {
      failure = error
    }
    expect(String(failure)).matches(/Restore the (?:verified )?pre-cutover/)
    expect(
      (await pool.query('select name from schema_migrations order by name'))
        .rows
    ).deep.equals(before.filter(row => row.name < '072'))
    expect((await migrateUp(pool, migrations)).applied).deep.equals(
      migrations.filter(m => m.name >= '072').map(m => m.name)
    )
  })
})

describe('reversible migration history before persistent guest identities', function () {
  this.timeout(60000)
  const name = `teamstation_history_${process.pid}_${Date.now()}`
  const history = migrations.filter(m => m.name < '066')
  let admin: Pool
  let pool: Pool
  before(async () => {
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: adminUrl.replace(/\/[^/]*$/, `/${name}`)
    })
  })
  after(async () => {
    await pool?.end()
    await admin.query(`drop database if exists ${name}`)
    await admin.end()
  })
  it('rolls back and reapplies historical schemas, including below the baseline', async () => {
    await migrateUp(pool, history)
    expect(await migrateDown(pool, history, history.length)).length(
      history.length
    )
    const tables = await pool.query(
      "select tablename from pg_tables where schemaname = 'public'"
    )
    expect(tables.rows.map(row => row.tablename)).deep.equals([
      'schema_migrations'
    ])
    expect((await migrateUp(pool, history)).applied).deep.equals(
      history.map(m => m.name)
    )
    const down = await migrateDown(
      pool,
      history,
      history.filter(m => m.name >= BASELINE).length
    )
    expect(down.at(-1)).equals(BASELINE)
    expect((await migrateUp(pool, history)).applied).deep.equals(
      [...down].reverse()
    )
  })
  it('refuses to cross the persistent guest boundary even before the account cutover', async () => {
    const throughGuests = migrations.filter(m => m.name < '067')
    await migrateUp(pool, throughGuests)
    const before = (
      await pool.query('select name from schema_migrations order by name')
    ).rows
    let failure: unknown
    try {
      await migrateDown(pool, throughGuests, throughGuests.length)
    } catch (error) {
      failure = error
    }
    expect(String(failure)).includes('Restore the pre-cutover database backup')
    expect(
      (await pool.query('select name from schema_migrations order by name'))
        .rows
    ).deep.equals(before)
    expect((await migrateUp(pool, throughGuests)).applied).deep.equals([])
  })
})

describe('the baseline', function () {
  this.timeout(60000)

  const name = `teamstation_baseline_${Date.now()}`
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
    const { rows } = await pool.query<{ count: string | number }>(
      'select count(*) from schema_migrations'
    )
    expect(Number(rows[0].count)).equals(early.length + 1)
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
