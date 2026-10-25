import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'

/**
 * The games, of those given, scored in TeamStation: its scorer owns the
 * game, a stored play carries TeamStation's own record, or an at-bat is
 * under way. Their plays replay against the teams they were scored between,
 * so a schedule never changes their opponent.
 *
 * A caller about to change a game locks its row first and asks this in a
 * statement of its own, so it sees every post that held the lock before.
 */
export async function scoredInTeamStation(
  db: Kysely<Database>,
  gameIds: string[]
): Promise<Set<string>> {
  if (gameIds.length === 0) return new Set()
  const rows = await db
    .selectFrom('games')
    .select('id')
    .where('id', 'in', gameIds)
    .where(eb =>
      eb.or([
        eb('currentPlay', 'is not', null),
        eb('pregame', 'is not', null),
        eb('scoringOwner', '=', 'teamstation'),
        eb.exists(
          eb
            .selectFrom('events')
            .select('events.id')
            .whereRef('events.gameId', '=', 'games.id')
            .where(sql<boolean>`events.gumbo ? 'teamStation'`)
        )
      ])
    )
    .execute()
  return new Set(rows.map(row => row.id))
}

/**
 * Whether a schedule can never change a game's opponent: TeamStation scored
 * it, or neither of its teams is an external one.
 */
export function opponentFixed(
  game: { homeTeamExternal: boolean; awayTeamExternal: boolean },
  scored: boolean
): boolean {
  return scored || (!game.homeTeamExternal && !game.awayTeamExternal)
}
