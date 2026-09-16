import type { Pool } from 'pg'

export interface Migration {
  /** Sorts the migrations, and identifies an applied one. Never rename it. */
  name: string
  up: string
  down: string
}

export interface MigrationResult {
  applied: string[]
  alreadyApplied: string[]
}

const SETUP = `
create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
)
`

/**
 * Applies whatever has not run yet, in name order, each in its own
 * transaction. A migration that throws leaves the ones before it applied and
 * itself rolled back, so a re-run picks up where it stopped.
 */
export async function migrateUp(
  pool: Pool,
  migrations: Migration[]
): Promise<MigrationResult> {
  await pool.query(SETUP)
  const { rows } = await pool.query<{ name: string }>(
    'select name from schema_migrations'
  )
  const done = new Set(rows.map(row => row.name))

  const applied: string[] = []
  const alreadyApplied: string[] = []
  for (const migration of [...migrations].sort(byName)) {
    if (done.has(migration.name)) {
      alreadyApplied.push(migration.name)
      continue
    }
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(migration.up)
      await client.query('insert into schema_migrations (name) values ($1)', [
        migration.name
      ])
      await client.query('commit')
      applied.push(migration.name)
    } catch (error) {
      await client.query('rollback')
      throw new Error(
        `Migration ${migration.name} failed: ${String(
          error instanceof Error ? error.message : error
        )}`
      )
    } finally {
      client.release()
    }
  }
  return { applied, alreadyApplied }
}

/** Rolls back the most recently applied migrations, newest first. */
export async function migrateDown(
  pool: Pool,
  migrations: Migration[],
  count = 1
): Promise<string[]> {
  await pool.query(SETUP)
  const { rows } = await pool.query<{ name: string }>(
    'select name from schema_migrations order by name desc limit $1',
    [count]
  )

  const rolledBack: string[] = []
  for (const row of rows) {
    const migration = migrations.find(item => item.name === row.name)
    if (migration == null) {
      throw new Error(`Cannot roll back ${row.name}: it is not in the code`)
    }
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(migration.down)
      await client.query('delete from schema_migrations where name = $1', [
        migration.name
      ])
      await client.query('commit')
      rolledBack.push(migration.name)
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
  return rolledBack
}

const byName = (a: Migration, b: Migration): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0
