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
 *
 * The person can stop a turn: the app names it by the client id it sent
 * the message, or the confirm, with (`stopTurn`), and the row keeps that
 * name until the turn it names lets the conversation go. The row keeps the
 * running turn's own client id with its claim too (`runningTurn`), so an app
 * opened while the turn runs learns which turn to name. The turn holding
 * the claim reads the row every half second and, named, is told through
 * its signal. A stop that arrives before the turn has claimed (Stop pressed
 * right after Send) stops it as it claims. Client ids are never reused, so
 * a stop naming a turn already over stops nothing later.
 */

/** How long a claim lasts without being renewed. */
export const TURN_CLAIM_MS = 60000
/** How often a running turn renews its claim. */
export const TURN_RENEW_MS = 20000
/** How often a running turn looks for a stop naming it. */
export const TURN_STOP_POLL_MS = 500

export const TURN_RUNNING =
  'Tess is still answering. Wait for her reply, then try again.'

/**
 * Runs `turn` holding the person's conversation, or refuses with 409 while
 * another turn holds it, and with 410 once their account is deleted.
 * `clientId` is the app's id for the turn; its signal is aborted when a stop
 * names it. A turn from an older app, which sends none, cannot be stopped.
 */
export async function withTurn<T>(
  db: Kysely<Database>,
  userId: string,
  clientId: string | undefined,
  turn: (signal: AbortSignal) => Promise<T>,
  { renewMs = TURN_RENEW_MS, pollMs = TURN_STOP_POLL_MS } = {}
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
      .set({
        turn_owner: owner,
        turn_until: until,
        turn_client_id: clientId ?? null
      })
      .where('user_id', '=', userId)
      .where(eb =>
        eb.or([
          eb('turn_until', 'is', null),
          eb('turn_until', '<', sql<Date>`now()`)
        ])
      )
      .returning('turn_stop')
      .executeTakeFirst()
  })
  if (claimed == null) throw conflict(TURN_RUNNING)
  const stop = new AbortController()
  const named = (stopping: string | null | undefined): boolean =>
    clientId != null && stopping === clientId
  if (named(claimed.turn_stop)) stop.abort()
  // One read at a time, and none once the turn is over or stopped.
  let polling: Promise<unknown> | undefined
  const poll =
    clientId == null
      ? undefined
      : setInterval(() => {
          if (stop.signal.aborted) return
          polling ??= db
            .selectFrom('tess_conversations')
            .select('turn_stop')
            .where('user_id', '=', userId)
            .where('turn_owner', '=', owner)
            .executeTakeFirst()
            .then(row => {
              if (named(row?.turn_stop)) stop.abort()
            })
            .catch(() => undefined)
            .finally(() => {
              polling = undefined
            })
        }, pollMs)
  // A timer of its own keeps no process alive.
  const timer: unknown = poll
  if (
    typeof timer === 'object' &&
    timer != null &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  )
    timer.unref()
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
    return await turn(stop.signal)
  } finally {
    clearInterval(renew)
    clearInterval(poll)
    await renewing
    await polling
    // A release that fails leaves the claim to lapse. A stop naming this
    // turn is done with; one naming another (the next, sent already) stays.
    await db
      .updateTable('tess_conversations')
      .set({
        turn_owner: null,
        turn_until: null,
        turn_client_id: null,
        ...(clientId == null
          ? {}
          : {
              turn_stop: sql<
                string | null
              >`case when turn_stop = ${clientId} then null else turn_stop end`
            })
      })
      .where('user_id', '=', userId)
      .where('turn_owner', '=', owner)
      .execute()
      .catch(() => undefined)
  }
}

/**
 * The person asks to stop the turn the app sent with `clientId`. Noted on
 * their conversation, made for them if they have none yet, whether or not
 * that turn is running: the turn reads it while it runs, or as it claims.
 * Once their account is deleted, 410.
 */
export async function stopTurn(
  db: Kysely<Database>,
  userId: string,
  clientId: string
): Promise<void> {
  await whileLive(db, userId, async trx => {
    await trx
      .insertInto('tess_conversations')
      .values({ user_id: userId, turn_stop: clientId })
      .onConflict(on =>
        on.column('user_id').doUpdateSet({ turn_stop: clientId })
      )
      .execute()
  })
}

/**
 * The turn holding the person's conversation now, if one does: with the
 * client id the app sent it with, so an app opened while it runs can stop
 * it, when it was sent with one. A claim that has lapsed holds nothing, and
 * its id names nothing.
 */
export async function runningTurn(
  db: Kysely<Database>,
  userId: string
): Promise<{ clientId?: string } | null> {
  const row = await db
    .selectFrom('tess_conversations')
    .select(['turn_client_id', sql<boolean>`turn_until > now()`.as('running')])
    .where('user_id', '=', userId)
    .executeTakeFirst()
  if (row?.running !== true) return null
  return row.turn_client_id == null ? {} : { clientId: row.turn_client_id }
}
