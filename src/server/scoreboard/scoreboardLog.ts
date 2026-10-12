import { isDeepStrictEqual } from 'node:util'

import { type Kysely, sql } from 'kysely'

import type { DashboardOverrides, SourceState } from '../../common/scoreboard'
import type { Database, ScoreboardLogTable } from '../db/database'

/**
 * The scoreboard log: one row for each write that changed a game's board and
 * was not TeamStation scoring, which is replayed from its stored plays
 * instead. A row holds the whole non-scoring state after the write, so any
 * one row says what the publisher and the dashboard had the board showing
 * from its `at` until the next.
 */

export type ScoreboardLogCause = ScoreboardLogTable['cause']

export interface ScoreboardLogRow {
  gameId: string
  /** The Redis write's version for the game. */
  version: number
  /** The store's `now` for the write: when the server took it in. */
  at: number
  cause: ScoreboardLogCause
  /** Whoever's socket sent the write; null for the server's own. */
  actorId: number | null
  /** The publisher's slot after the write; none after a reset. */
  publisher: SourceState | undefined
  overrides: DashboardOverrides
}

/**
 * Logs one write, unless it changed nothing the log holds.
 *
 * Every worker logs the writes it made, so two workers' rows for one game can
 * arrive in either order. They are taken one at a time under a lock on the
 * game, in one transaction, and a row no newer than the newest one logged is
 * skipped: the newer row already holds the whole state after both writes.
 *
 * A row is written when the publisher's state, its `receivedAt` or the
 * overrides changed. A contested packet that repeats the publisher's state
 * still moves `receivedAt`, which makes the publisher the newer source again,
 * so it is logged. A packet of only uncontested fields that changed nothing,
 * and an override write that set what was already set, are not.
 */
export async function logScoreboard(
  db: Kysely<Database>,
  row: ScoreboardLogRow
): Promise<'inserted' | 'skipped'> {
  const publisher =
    row.publisher == null
      ? null
      : plain({
          state: row.publisher.state,
          receivedAt: row.publisher.receivedAt
        })
  const overrides = plain(row.overrides)
  return await db.transaction().execute(async trx => {
    await sql`select pg_advisory_xact_lock(hashtext(${`scoreboard_log:${row.gameId}`}))`.execute(
      trx
    )
    const newest = await trx
      .selectFrom('scoreboard_log')
      .select(['version', 'publisher', 'overrides'])
      .where('game_id', '=', row.gameId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (newest != null) {
      if (newest.version >= row.version) return 'skipped'
      if (
        isDeepStrictEqual(newest.publisher, publisher) &&
        isDeepStrictEqual(newest.overrides, overrides)
      )
        return 'skipped'
    }
    await trx
      .insertInto('scoreboard_log')
      .values({
        game_id: row.gameId,
        version: row.version,
        at: new Date(row.at),
        cause: row.cause,
        actor_id: row.actorId,
        publisher,
        overrides
      })
      .execute()
    return 'inserted'
  })
}

/**
 * A value as Postgres gives it back from `jsonb`: without keys whose value is
 * undefined, which the cleaners leave on an optional field, so a stored row
 * and a new one compare equal when they hold the same thing.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
