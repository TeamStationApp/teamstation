/**
 * The cluster every database test makes its scratch databases on:
 * `TS_TEST_DATABASE_URL` when it is set, and otherwise localhost:5433, the
 * local Postgres 18 cluster, never the older server on 5432 beside it.
 * `requirePostgres18.js` runs under plain Node before the tests, so it keeps
 * the one other copy of this rule.
 */
import type { Pool } from 'pg'

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
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  for (;;) {
    const result = await admin.query<{ sessions: number }>(
      'select count(*)::int as sessions from pg_stat_activity where datname=$1',
      [name]
    )
    const sessions = result.rows[0].sessions
    if (sessions === 0) break
    if (Date.now() >= deadline)
      throw new Error('Scratch database still has open sessions')
    options.onWait?.(sessions)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  // Pool.end can resolve before the socket's end/remove acknowledgement.
  // A normal DROP now succeeds without killing an ending client.
  await admin.query(`drop database if exists "${name}"`)
}
