import { sql, type Transaction } from 'kysely'

import type { Database } from './database'

/**
 * Takes a transaction-scoped advisory lock on each key, once each, in one
 * sorted order, so two transactions that share keys queue rather than each
 * making the same row, and two that share two keys cannot each hold one.
 * One statement for every key: Postgres evaluates a volatile function in
 * the select list after the sort, so the locks are taken in `k` order. The
 * locks are released when the transaction ends.
 */
export async function lockKeys(
  trx: Transaction<Database>,
  keys: string[]
): Promise<void> {
  const unique = [...new Set(keys)]
  if (unique.length === 0) return
  await sql`select pg_advisory_xact_lock(hashtextextended(k, 0)) from unnest(${unique}::text[]) as k order by k`.execute(
    trx
  )
}
