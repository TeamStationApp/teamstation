import type { Kysely, Transaction } from 'kysely'

import { gone } from '../../common/errors'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'

/**
 * Tess writes for a person only while their account stands. Deleting an
 * account removes everything Tess kept of it, in the transaction that marks
 * the person deleted, and a turn still running then must not write any of
 * it back.
 *
 * The foreign keys do not stop it: the person's row stays, emptied, and the
 * lock a key check takes does not wait for that row's update. So every
 * write of Tess's first locks the row `for share`, in its own transaction.
 * A deletion that holds the row (it takes it `for update`) is waited for,
 * and the row is then read deleted; one that comes after waits for the
 * write, and deletes what it wrote.
 */

export const ACCOUNT_DELETED = 'This account has been deleted'

/**
 * Holds the person's row for the rest of `trx`, or refuses with 410 when
 * their account has been deleted.
 */
export async function holdLiveUser(
  trx: Transaction<Database>,
  userId: string
): Promise<void> {
  const row = await trx
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .forShare()
    .executeTakeFirst()
  if (row == null) throw gone(ACCOUNT_DELETED)
}

/** Runs `write` in a transaction that holds the person's row, as above. */
export async function whileLive<T>(
  db: Kysely<Database>,
  userId: string,
  write: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  return await atomic(db, async trx => {
    await holdLiveUser(trx, userId)
    return await write(trx)
  })
}
