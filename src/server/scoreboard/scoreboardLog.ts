import { isDeepStrictEqual } from 'node:util'

import { type Kysely, sql } from 'kysely'

import {
  CONTESTED_FIELDS,
  type DashboardOverrides,
  SCOREBOARD_DEFAULTS,
  type ScoreboardUpdate,
  type SourceState
} from '../../common/scoreboard'
import {
  radarPacket,
  type RadarReading
} from '../../common/scoring/radarSpeeds'
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
  radar?: Pick<RadarReading, 'pitchSpeed' | 'exitVelocity'>
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
 * skipped unless it contains an explicit radar reading: the newer row holds
 * the board state, but cannot stand in for an earlier measurement.
 *
 * A row is written when the publisher's state, its `receivedAt` or the
 * overrides changed. A contested packet that repeats the publisher's state
 * still moves `receivedAt`, which makes the publisher the newer source again,
 * so it is logged. A packet of only uncontested fields that changed nothing,
 * and an override write that set what was already set, are not: a speed of 0
 * on a slot that never had one is what the board showed already (`shown`).
 * Explicit positive radar packets are always retained, even at the same speed.
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
  const radar = row.cause === 'publisher' ? radarPacket(row.radar) : undefined
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
      if (radar == null && newest.version >= row.version) return 'skipped'
      if (
        radar == null &&
        isDeepStrictEqual(
          // Written by this function, from the slot.
          shown(newest.publisher as SourceState | null),
          shown(publisher)
        ) &&
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
        radar:
          radar == null
            ? null
            : {
                ...radar,
                // These snapshots were historically skipped. Retain their
                // measurements without changing the cached board timeline.
                ...(newest != null && newest.version > row.version
                  ? { measurementOnly: true }
                  : {})
              },
        overrides
      })
      .onConflict(oc => oc.columns(['game_id', 'version']).doNothing())
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

/** The uncontested fields, which no other source sets. */
const UNCONTESTED = (
  Object.keys(SCOREBOARD_DEFAULTS) as Array<keyof ScoreboardUpdate>
).filter(field => !(CONTESTED_FIELDS as readonly string[]).includes(field))

/**
 * The publisher's slot as the board reads it, for comparing two: an
 * uncontested field it has not set shows the board's default, so leaving it
 * out and setting the default are the same. A contested field it has not set
 * lets the game's own show through instead, so it is left as it is; a packet
 * that sets one moves `receivedAt` anyway.
 */
function shown(publisher: SourceState | null): SourceState | null {
  if (publisher == null) return null
  const state: ScoreboardUpdate = { ...publisher.state }
  for (const field of UNCONTESTED)
    if (state[field] === undefined)
      Object.assign(state, { [field]: SCOREBOARD_DEFAULTS[field] })
  return { state, receivedAt: publisher.receivedAt }
}
