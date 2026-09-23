import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from './migrations'
import { migrateDown, migrateUp } from './runner'
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
})
