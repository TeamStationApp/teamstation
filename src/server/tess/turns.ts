import { randomUUID } from 'node:crypto'

import { type Kysely, sql } from 'kysely'

import { conflict } from '../../common/errors'
import type { Database } from '../db/database'
import { whileLive } from './liveUser'

/**
 * One turn at a time on a person's conversation: a message, or a confirmed
 * change and Tess's report on it. Two at once would each build a request
 * from their own view of the conversation and store their rounds into each
 * other's.
 *
 * Every core runs its own worker, so the claim is a row: a turn takes the
 * conversation for a minute and renews the claim while it runs, and another
 * turn meanwhile is refused with 409 at once, rather than left waiting
 * behind a reply that can take minutes. A worker that dies mid-turn stops
 * renewing, and its claim lapses within the minute. A transaction-scoped
 * advisory lock would instead hold a transaction, and a pooled connection,
 * for the whole turn, while the loopback requests of its tools need
 * connections from the same pool.
 */

/** How long a claim lasts without being renewed. */
export const TURN_CLAIM_MS = 60000
/** How often a running turn renews its claim. */
export const TURN_RENEW_MS = 20000

export const TURN_RUNNING =
  'Tess is still answering. Wait for her reply, then try again.'

/**
 * Runs `turn` holding the person's conversation, or refuses with 409 while
 * another turn holds it, and with 410 once their account is deleted.
 */
export async function withTurn<T>(
  db: Kysely<Database>,
  userId: string,
  turn: () => Promise<T>,
  renewMs = TURN_RENEW_MS
): Promise<T> {
  const owner = randomUUID()
  const until = sql<Date>`now() + make_interval(secs => ${TURN_CLAIM_MS / 1000})`
  const claimed = await whileLive(db, userId, async trx => {
    await trx
      .insertInto('tess_conversations')
      .values({ user_id: userId })
      .onConflict(on => on.column('user_id').doNothing())
      .execute()
    return await trx
      .updateTable('tess_conversations')
      .set({ turn_owner: owner, turn_until: until })
      .where('user_id', '=', userId)
      .where(eb =>
        eb.or([
          eb('turn_until', 'is', null),
          eb('turn_until', '<', sql<Date>`now()`)
        ])
      )
      .returning('user_id')
      .executeTakeFirst()
  })
  if (claimed == null) throw conflict(TURN_RUNNING)
  // One renewal at a time, and none left running once the turn is over.
  let renewing: Promise<unknown> | undefined
  const renew = setInterval(() => {
    renewing ??= db
      .updateTable('tess_conversations')
      .set({ turn_until: until })
      .where('user_id', '=', userId)
      .where('turn_owner', '=', owner)
      .execute()
      .catch(() => undefined)
      .finally(() => {
        renewing = undefined
      })
  }, renewMs)
  try {
    return await turn()
  } finally {
    clearInterval(renew)
    await renewing
    // A release that fails leaves the claim to lapse.
    await db
      .updateTable('tess_conversations')
      .set({ turn_owner: null, turn_until: null })
      .where('user_id', '=', userId)
      .where('turn_owner', '=', owner)
      .execute()
      .catch(() => undefined)
  }
}

/** Whether a turn holds the person's conversation now. */
export async function turnRunning(
  db: Kysely<Database>,
  userId: string
): Promise<boolean> {
  const row = await db
    .selectFrom('tess_conversations')
    .select(sql<boolean>`turn_until > now()`.as('running'))
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return row?.running === true
}
