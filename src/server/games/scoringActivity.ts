import { type RawBuilder, sql, type SqlBool } from 'kysely'

import { SUBSTITUTION_TYPES } from '../../common/gumboPlay'

/** Shared by status writes and every LIVE projection, including after undo. */
export function scoringActivitySql(
  currentPlay: RawBuilder<unknown>
): RawBuilder<boolean> {
  return sql<boolean>`(
    exists(select 1 from events where events."gameId" = games.id
      and ts_play_has_started(events.gumbo))
    or ts_play_has_started(${currentPlay})
  )`
}

export const hasScoringEventsSql = scoringActivitySql(
  sql.ref('games.currentPlay')
)

/**
 * A stored play with a result of its own: an intentional walk begins no game
 * by `hasScoringEventsSql`'s reading, and is on the record all the same, with
 * the game's lineup past reconciling. A lineup change stored ahead of a first
 * pitch is neither.
 */
export const isRealPlaySql = sql<SqlBool>`coalesce(
    events.gumbo->'result'->>'eventType', ''
  ) not in (${sql.join(SUBSTITUTION_TYPES.map(type => sql.lit(type)))})`
