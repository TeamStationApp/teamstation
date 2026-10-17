import { type RawBuilder, sql } from 'kysely'

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
