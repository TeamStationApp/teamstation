import type { Kysely } from 'kysely'

import { notFound } from '../../common/errors'
import { canSeeGame, visibleScopes } from '../access'
import type { Database } from '../db/database'

/**
 * Throws 404 unless the game exists and this person can see it.
 *
 * The one check that a game is someone's to act on: the events routes call it
 * before reading or writing plays, and dictation calls it before each
 * utterance about a game.
 */
export async function requireVisibleGame(
  db: Kysely<Database>,
  userId: number,
  isAdmin: boolean,
  gameId: string
): Promise<void> {
  const game = await db
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id', 'season_id'])
    .where('id', '=', gameId)
    .executeTakeFirst()
  if (game == null) throw notFound()
  const scopes = await visibleScopes(db, userId, isAdmin)
  if (
    !canSeeGame(scopes, {
      homeTeamId: game.home_team_id,
      awayTeamId: game.away_team_id,
      seasonId: game.season_id
    })
  ) {
    throw notFound()
  }
}
