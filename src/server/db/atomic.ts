import type { Kysely, Transaction } from 'kysely'

import type { Database } from './database'

/** Compose services within one transaction instead of silently committing an inner step. */
export async function atomic<T>(
  db: Kysely<Database>,
  write: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return db.isTransaction
    ? await write(db as Transaction<Database>)
    : await db.transaction().execute(write)
}
