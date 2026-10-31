import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

import type { Database } from '../../src/server/db/database'
import { attachInt8Parser } from '../../src/server/db/int8'

/** What marks a database as one this tool may write to. */
const MARKERS = ['stress-', 'dbload-local']

export type LoadDatabase = Kysely<Database>

/**
 * The tool's own connections: few, because they share a server that is under
 * test, and named, so the sampler can tell them from the server's.
 */
export function openLoadDatabase(
  url: string,
  options: { max?: number; applicationName?: string } = {}
): LoadDatabase {
  attachInt8Parser()
  const pool = new Pool({
    connectionString: url,
    max: options.max ?? 5,
    application_name: options.applicationName ?? 'dbload-fixture'
  })
  // A connection lost while idle is reported here; unheard it would be fatal.
  pool.on('error', () => undefined)
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
}

/**
 * Refuses any database whose comment does not mark it as generated, which is
 * every database that holds anything real. Everything in this tool that reads
 * or writes passes through here first.
 */
export async function requireLoadDatabase(
  query: (
    text: string
  ) => Promise<{ rows: Array<{ comment: string | null; name: string }> }>
): Promise<string> {
  const { rows } = await query(
    `select shobj_description(oid, 'pg_database') as comment, datname as name
     from pg_database where datname = current_database()`
  )
  const comment = rows[0]?.comment ?? ''
  if (!MARKERS.some(marker => comment.startsWith(marker)))
    throw new Error(
      `Database ${rows[0]?.name ?? '(unknown)'} is not marked for load testing: its COMMENT must start stress- or dbload-local`
    )
  return comment
}
