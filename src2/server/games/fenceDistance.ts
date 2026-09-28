import { type Kysely, sql } from 'kysely'

import { DEFAULT_FENCE_DISTANCE_FT } from '../../common/fenceDistance'
import type { Database } from '../db/database'

/**
 * The fence a `games` row is played to, in feet, as SQL on that row: its own,
 * else its season's, else that season's league's, else
 * `DEFAULT_FENCE_DISTANCE_FT`. It reads the row as `games`, so it serves a
 * select from `games` and an update of it alike.
 */
export const resolvedFenceDistance = sql<number>`coalesce(games.fence_distance_ft, (select coalesce(seasons.fence_distance_ft, leagues.fence_distance_ft) from seasons left join leagues on leagues.id = seasons.league_id where seasons.id = games.season_id), ${DEFAULT_FENCE_DISTANCE_FT}::integer)`

/**
 * Whether a game has plays stored. A game's fence is fixed from its first
 * play, whatever its status: a game cancelled after plays were posted keeps
 * them, and the fence they were sized by.
 *
 * Every writer of a game's fence locks the game row first, as a post does,
 * then asks this in a statement of its own, which sees every post that held
 * the lock before: each statement reads what committed before it began. A
 * statement that waited on the lock itself keeps the snapshot it began with,
 * so asked there it could miss the plays the lock's holder stored.
 */
export async function gameHasPlays(
  db: Kysely<Database>,
  gameId: string
): Promise<boolean> {
  const row = await db
    .selectFrom('events')
    .select('id')
    .where('gameId', '=', gameId)
    .limit(1)
    .executeTakeFirst()
  return row != null
}

/**
 * The fence a game is played to, in feet, as `resolvedFenceDistance` says. A
 * game nobody holds is played to the default too.
 */
export async function fenceDistanceFor(
  db: Kysely<Database>,
  gameId: string
): Promise<number> {
  const row = await db
    .selectFrom('games')
    .select(resolvedFenceDistance.as('fenceDistanceFt'))
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  return Number(row?.fenceDistanceFt ?? DEFAULT_FENCE_DISTANCE_FT)
}
