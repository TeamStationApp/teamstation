import { randomUUID } from 'node:crypto'

import type { Kysely, UpdateQueryBuilder } from 'kysely'

import { validateRecap } from '../../common/gameRecap'
import type { Database } from '../db/database'
import { announceNotedScopes } from '../socket/syncRevision'
import type { RecapWriter } from './model'
import { expireRecaps, finalGame, recapSnapshot } from './queue'

const LEASE_MS = 120000
const RETRY_MS = 5000

/** Claims and snapshots under the same game lock as scoring, then releases it before HTTP. */
export async function runRecap(
  db: Kysely<Database>,
  write: RecapWriter,
  signal: AbortSignal,
  now = new Date()
): Promise<boolean> {
  await expireRecaps(db, now)
  const candidate = await db
    .selectFrom('game_recaps')
    .select('game_id')
    .where('status', '=', 'pending')
    .where('attempts', '<', 3)
    .where('available_at', '<=', now)
    .where(finalGame)
    .orderBy('available_at')
    .executeTakeFirst()
  if (candidate == null || signal.aborted) return false
  const job = await db.transaction().execute(async trx => {
    const game = await trx
      .selectFrom('games')
      .selectAll()
      .where('id', '=', candidate.game_id)
      .forUpdate()
      .executeTakeFirst()
    if (game?.status !== 'final') return null
    const lease = randomUUID()
    const claimed = await trx
      .updateTable('game_recaps')
      .set(eb => ({
        lease_id: lease,
        attempts: eb('attempts', '+', 1),
        available_at: new Date(now.getTime() + LEASE_MS)
      }))
      .where('game_id', '=', candidate.game_id)
      .where('status', '=', 'pending')
      .where('attempts', '<', 3)
      .where('available_at', '<=', now)
      .returningAll()
      .executeTakeFirst()
    if (claimed == null) return null
    const snapshot = await recapSnapshot(trx, game.id)
    await trx
      .updateTable('game_recaps')
      .set({ context_digest: snapshot.contextDigest })
      .where('game_id', '=', game.id)
      .execute()
    return { ...claimed, ...snapshot, lease }
  })
  if (job == null) return false
  const current = (
    connection = db
  ): UpdateQueryBuilder<Database, 'game_recaps', 'game_recaps', unknown> =>
    connection
      .updateTable('game_recaps')
      .where('game_id', '=', job.game_id)
      .where('request_id', '=', job.request_id)
      .where('lease_id', '=', job.lease)
      .where('status', '=', 'pending')
      .where(finalGame)
  try {
    const document = validateRecap(
      await write(job.input, signal),
      new Set(job.input.plays.map(p => p.about.atBatIndex))
    )
    if (!signal.aborted) {
      const contextDigest = (await recapSnapshot(db, job.game_id)).contextDigest
      if (contextDigest !== job.contextDigest) {
        await current()
          .set({
            status: 'pending',
            document: null,
            attempts: 0,
            request_id: randomUUID(),
            lease_id: null,
            available_at: new Date(),
            context_digest: contextDigest
          })
          .execute()
        return true
      }
      await db.transaction().execute(async trx => {
        const changed = await current(trx)
          .set({ status: 'ready', document, lease_id: null })
          .returning('game_id')
          .executeTakeFirst()
        if (changed != null)
          await announceNotedScopes(trx, { gameId: changed.game_id })
      })
    }
  } catch {
    // Model errors may contain credentials or submitted data. Persist only the state.
    await db.transaction().execute(async trx => {
      const changed = await current(trx)
        .set({
          status: job.attempts >= 3 ? 'failed' : 'pending',
          lease_id: null,
          available_at: new Date(now.getTime() + RETRY_MS)
        })
        .returning('game_id')
        .executeTakeFirst()
      if (changed != null && job.attempts >= 3)
        await announceNotedScopes(trx, { gameId: changed.game_id })
    })
  }
  return true
}

/** One bounded request at a time; persisted leases let another process recover a crash. */
export function startRecaps(
  db: Kysely<Database>,
  write: RecapWriter,
  pollMs = 1000
): { stop: () => Promise<void> } {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> = Promise.resolve()
  const tick = (): void => {
    running = runRecap(db, write, controller.signal)
      .then(() => undefined)
      .catch(() => {
        console.error('Recap worker could not process a request')
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          timer = setTimeout(tick, pollMs)
          // Native app test imports see React Native’s numeric timer overload.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
          ;(timer as unknown as NodeJS.Timeout).unref()
        }
      })
  }
  tick()
  return {
    stop: async () => {
      controller.abort()
      clearTimeout(timer)
      await running
    }
  }
}
