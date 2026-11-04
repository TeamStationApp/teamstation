import type { Kysely, Transaction } from 'kysely'

import type { Database } from './database'

/** Compose scoring readers within one repeatable-read snapshot. */
export async function readSnapshot<T>(
  db: Kysely<Database>,
  read: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return db.isTransaction
    ? await read(db as Transaction<Database>)
    : await db.transaction().setIsolationLevel('repeatable read').execute(read)
}
