/**
 * The cluster every database test makes its scratch databases on:
 * `TS_TEST_DATABASE_URL` when it is set, and otherwise localhost:5433, the
 * local Postgres 18 cluster, never the older server on 5432 beside it.
 * `requirePostgres18.js` runs under plain Node before the tests, so it keeps
 * the one other copy of this rule.
 */
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'

import { Pool } from 'pg'

import type { Migration } from './runner'
import { migrateUp } from './runner'

export const testDatabaseUrl =
  process.env.TS_TEST_DATABASE_URL ?? 'postgres://localhost:5433/postgres'

/**
 * Today's read code on an older schema: what a test of an old migration needs
 * to read its result as the server does.
 */
export async function addPlayerNamePrivacy(pool: Pool): Promise<void> {
  await pool.query(`
    alter table leagues add column player_name_privacy text;
    alter table seasons add column player_name_privacy text;
    alter table teams add column player_name_privacy text`)
}

/** Waits for graceful client shutdown; never terminates a leaked test session. */
export async function dropScratchDatabase(
  admin: Pool,
  name: string,
  options: { timeoutMs?: number; onWait?: (sessions: number) => void } = {}
): Promise<void> {
  if (!/^teamstation_[a-z0-9_]+$/.test(name))
    throw new Error('Expected a generated scratch database name')
  await waitForNoSessions(admin, name, options)
  // Pool.end can resolve before the socket's end/remove acknowledgement.
  // A normal DROP now succeeds without killing an ending client.
  await admin.query(`drop database if exists "${name}"`)
}

async function waitForNoSessions(
  admin: Pool,
  name: string,
  options: { timeoutMs?: number; onWait?: (sessions: number) => void } = {}
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  for (;;) {
    const result = await admin.query<{ sessions: number }>(
      'select count(*)::int as sessions from pg_stat_activity where datname=$1',
      [name]
    )
    const sessions = result.rows[0].sessions
    if (sessions === 0) return
    if (Date.now() >= deadline)
      throw new Error('Scratch database still has open sessions')
    options.onWait?.(sessions)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The URL of database `name` on the test cluster. */
export function testDatabaseUrlOf(name: string): string {
  return testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
}

const TEMPLATE_PREFIX = 'teamstation_template_'
const host = createHash('sha256').update(hostname()).digest('hex').slice(0, 6)
const templates = new Map<string, Promise<string>>()
/** Numbers this process's templates; never reused, even after a failure. */
let templatesMade = 0

/**
 * Creates database `name` on the test cluster already migrated through
 * `schema`. The first call in a process for a schema migrates a template
 * database; every call after it copies that template, which takes a fraction
 * of the time the migrations do, so a fixture can afford a database per test.
 */
export async function createMigratedDatabase(
  admin: Pool,
  name: string,
  schema: Migration[]
): Promise<void> {
  const template = await templateFor(admin, schema)
  // Copying the files is about twice as fast as the WAL_LOG default for a
  // database this small, and leaves one that drops faster too.
  await admin.query(
    `create database ${name} template ${template} strategy file_copy`
  )
  // A copy holds its template's rows, the roster cache's epoch among them, as
  // a restored database does. Like one, it gets an epoch of its own
  // (`roster-cache-epoch`), or two copies would read each other's cache.
  const copy = new Pool({ connectionString: testDatabaseUrlOf(name), max: 1 })
  try {
    await copy.query(
      `do $$ begin
        if to_regclass('roster_cache_epoch') is not null then
          update roster_cache_epoch set epoch = gen_random_uuid()::text;
        end if;
      end $$`
    )
  } finally {
    await copy.end()
  }
}

async function templateFor(admin: Pool, schema: Migration[]): Promise<string> {
  const key = schemaKey(schema)
  let template = templates.get(key)
  if (template == null) {
    template = makeTemplate(admin, templatesMade++, schema)
    templates.set(key, template)
    template.catch(() => templates.delete(key))
  }
  return await template
}

/**
 * The schema in full: every migration's name, SQL and steps. Two schemas share
 * a template only when all of it is the same.
 */
function schemaKey(schema: Migration[]): string {
  return JSON.stringify(
    schema.map(migration => [
      migration.name,
      migration.up,
      migration.down,
      migration.steps?.toString() ?? ''
    ])
  )
}

/**
 * Templates are named for this host and process, so parallel test workers
 * never copy one another's half-built template, and one left by a process
 * that has since exited is found and dropped by the next run on this host.
 */
async function makeTemplate(
  admin: Pool,
  index: number,
  schema: Migration[]
): Promise<string> {
  await dropOrphanTemplates(admin)
  const name = `${TEMPLATE_PREFIX}${index}_${host}_${process.pid}`
  // A recycled pid can find its predecessor's template.
  await admin.query(`drop database if exists ${name}`)
  await admin.query(`create database ${name}`)
  const pool = new Pool({ connectionString: testDatabaseUrlOf(name) })
  try {
    await migrateUp(pool, schema)
  } finally {
    await pool.end()
  }
  // A template with a session still open cannot be copied.
  await waitForNoSessions(admin, name)
  return name
}

async function dropOrphanTemplates(admin: Pool): Promise<void> {
  const { rows } = await admin.query<{ datname: string }>(
    'select datname from pg_database where starts_with(datname, $1)',
    [TEMPLATE_PREFIX]
  )
  for (const { datname } of rows) {
    const match = /_([0-9a-f]{6})_(\d+)$/.exec(datname)
    if (match?.[1] !== host || processIsAlive(Number(match[2]))) continue
    await admin.query(`drop database if exists ${datname} with (force)`)
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
