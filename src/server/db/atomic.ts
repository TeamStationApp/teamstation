import type { Kysely, Transaction } from 'kysely'

import { announceNoted, announcesWhenDone } from '../socket/syncRevision'
import type { Database } from './database'

/** Work to run once a transaction `atomic` opened has committed. */
type AfterCommit = (db: Kysely<Database>) => Promise<void>

/** The transactions `atomic` opened, and what each runs once committed. */
const committed = new WeakMap<Kysely<Database>, AfterCommit[]>()

/** Work after a commit still running. */
const running = new Set<Promise<void>>()

/**
 * Starts `task` against `db` without waiting for it: what a commit lets go
 * of is never the request's to wait on. A failure is logged.
 */
function start(db: Kysely<Database>, task: AfterCommit): void {
  const run = (async () => {
    await task(db)
  })()
    .catch((error: unknown) => {
      console.error(`after commit: ${String(error)}`)
    })
    .finally(() => {
      running.delete(run)
    })
  running.add(run)
}

/**
 * Settles once all the work after a commit started so far has finished.
 * Tests wait on it; a request never does.
 */
export async function afterCommitsSettled(): Promise<void> {
  while (running.size > 0) await Promise.all([...running])
}

/**
 * Compose services within one transaction instead of silently committing an
 * inner step. When this opened the transaction, its last statement announces
 * whatever screen scope changes the writes in it noted, and once it has
 * committed it starts what `afterCommit` queued in it, against `db`, and
 * returns without waiting for it.
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
  for (const task of queued) start(db, task)
  return result
}

/**
 * Runs `task` once what `db` has written is committed: started now, outside
 * a transaction, or once the transaction `atomic` opened commits; either way
 * the caller does not wait for it to finish (`afterCommitsSettled` does). A
 * rolled back transaction runs nothing. A transaction opened some other way
 * throws, because nothing would ever run the task. `task` is given a
 * connection outside the transaction; a failure it lets out is logged.
 */
export async function afterCommit(
  db: Kysely<Database>,
  task: AfterCommit
): Promise<void> {
  if (!db.isTransaction) {
    start(db, task)
    return
  }
  const queued = committed.get(db)
  if (queued == null)
    throw new Error(
      'Work after a commit is queued in a transaction atomic opened'
    )
  queued.push(task)
}
