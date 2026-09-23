import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

export type GameStatsStatus =
  | { status: 'none' }
  | {
      status: 'pending' | 'built' | 'incomplete' | 'failed'
      detail: string | null
      builtAt: Date | null
    }

/** Where a game's stats stand, for the box score and the CLI. */
export async function gameStatsStatus(
  db: Kysely<Database>,
  gameId: string
): Promise<GameStatsStatus> {
  const row = await db
    .selectFrom('game_stats_state')
    .select(['status', 'detail', 'built_at'])
    .where('game_id', '=', gameId)
    .executeTakeFirst()
  if (row == null) return { status: 'none' }
  return {
    status: row.status,
    detail: row.detail,
    builtAt: row.built_at == null ? null : new Date(row.built_at)
  }
}
