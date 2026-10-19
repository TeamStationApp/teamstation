import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

/** A demo link needs somebody who batted, including in pitcher-only games. */
export async function sampleBatter(
  db: Kysely<Database>,
  teamId: string
): Promise<number | null> {
  const row = await db
    .selectFrom('game_player_stats')
    .innerJoin('gumbo_ids', 'gumbo_ids.gumbo_id', 'game_player_stats.gumbo_id')
    .select('user_id')
    .select(eb => eb.fn.sum<number>('pa').as('pa'))
    .where('team_id', '=', teamId)
    .where('pa', '>', 0)
    .groupBy('user_id')
    .orderBy('pa', 'desc')
    .executeTakeFirst()
  return row?.user_id ?? null
}
