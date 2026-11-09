import type { Kysely, Transaction } from 'kysely'

import { announceNoted, announcesWhenDone } from '../socket/syncRevision'
import type { Database } from './database'

/** Work to run once a transaction `atomic` opened has committed. */
type AfterCommit = (db: Kysely<Database>) => Promise<void>

/** The transactions `atomic` opened, and what each runs once committed. */
const committed = new WeakMap<Kysely<Database>, AfterCommit[]>()

/**
 * Compose services within one transaction instead of silently committing an
 * inner step. When this opened the transaction, its last statement announces
 * whatever screen scope changes the writes in it noted, and once it has
 * committed it runs what `afterCommit` queued in it, against `db`.
 */
export async function atomic<T>(
  db: Kysely<Database>,
  write: (trx: Transaction<Database>) => Promise<T>
): Promise<T> {
  if (db.isTransaction) return await write(db as Transaction<Database>)
  const queued: AfterCommit[] = []
  const result = await db.transaction().execute(async trx => {
    announcesWhenDone(trx)
    committed.set(trx, queued)
    const result = await write(trx)
    await announceNoted(trx)
    return result
  })
  for (const task of queued) await task(db)
  return result
}

/**
 * Runs `task` once what `db` has written is committed: now, outside a
 * transaction, or after the transaction `atomic` opened commits. A rolled
 * back transaction runs nothing. A transaction opened some other way throws,
 * because nothing would ever run the task. `task` is given a connection
 * outside the transaction, and handles its own failures.
 */
export async function afterCommit(
  db: Kysely<Database>,
  task: AfterCommit
): Promise<void> {
  if (!db.isTransaction) {
    await task(db)
    return
  }
  const queued = committed.get(db)
  if (queued == null)
    throw new Error(
      'Work after a commit is queued in a transaction atomic opened'
    )
  queued.push(task)
}
