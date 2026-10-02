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

/** The oldest server the migrations run on: 031's `virtual` columns need 18. */
const MIN_SERVER_VERSION = 180000

/**
 * The migration every database with history must already have.
 *
 * The migrations up to it were rewritten so an empty database is built without
 * an integration that has since left. They are right for an empty database and
 * for one that ran them all before the rewrite, and for nothing in between, so
 * a database part way through is refused rather than carried along.
 */
export const BASELINE = '045walkUpSongs'

/**
 * Refuses a server older than `MIN_SERVER_VERSION` before anything runs, so an
 * old cluster stops with a message that says why rather than partway through
 * the list with a syntax error.
 */
async function requireServerVersion(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ server_version_num: string }>(
    'show server_version_num'
  )
  const version = Number(rows[0]?.server_version_num)
  if (!(version >= MIN_SERVER_VERSION)) {
    throw new Error(
      `Postgres ${Math.floor(version / 10000)} is too old: the migrations ` +
        `need Postgres ${MIN_SERVER_VERSION / 10000} or later ` +
        `(server_version_num ${version})`
    )
  }
}

/**
 * Refuses a database whose history began before the rewrite and stops short
 * of `BASELINE`, before anything runs.
 *
 * Every such database recorded a migration whose file is gone, so it is told
 * apart from one the rewritten migrations built and then rolled back below the
 * baseline, which records only names that are still here and may go on.
 */
async function requireBaseline(
  pool: Pool,
  migrations: Migration[]
): Promise<void> {
  if (!migrations.some(migration => migration.name === BASELINE)) return
  const { rows: found } = await pool.query<{ name: string | null }>(
    "select to_regclass('schema_migrations')::text as name"
  )
  if (found[0]?.name == null) return
  const { rows } = await pool.query<{ name: string }>(
    'select name from schema_migrations'
  )
  const recorded = rows.map(row => row.name)
  if (recorded.includes(BASELINE)) return
  const known = new Set(migrations.map(migration => migration.name))
  if (recorded.every(name => known.has(name))) return
  const { rows: named } = await pool.query<{ name: string }>(
    'select current_database() as name'
  )
  throw new Error(
    `${named[0]?.name ?? 'This database'} predates ${BASELINE}: migrations ` +
      'before it were rewritten for empty databases; restore a production ' +
      'dump instead'
  )
}

/**
 * Applies whatever has not run yet, in name order, each in its own
 * transaction. A migration that throws leaves the ones before it applied and
 * itself rolled back, so a re-run picks up where it stopped.
 */
export async function migrateUp(
  pool: Pool,
  migrations: Migration[]
): Promise<MigrationResult> {
  await requireServerVersion(pool)
  await requireBaseline(pool, migrations)
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
