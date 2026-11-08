import type { Kysely, Transaction } from 'kysely'

import { announceNoted, announcesWhenDone } from '../socket/syncRevision'
import type { Database } from './database'

/**
 * Compose services within one transaction instead of silently committing an
 * inner step. When this opened the transaction, its last statement announces
 * whatever screen scope changes the writes in it noted.
 */
export async function atomic<T>(
  db: Kysely<Database>,
  write: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  if (db.isTransaction) return await write(db as Transaction<Database>)
  return await db.transaction().execute(async trx => {
    announcesWhenDone(trx)
    const result = await write(trx)
    await announceNoted(trx)
    return result
  })
}
