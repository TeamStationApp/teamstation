import type { Kysely } from 'kysely'

import { recordOf } from '../../common/scoring/gumbo'
import type { SessionContext, StoredGame } from '../../common/scoring/session'
import type { Database } from '../db/database'
import { fenceDistanceFor } from '../games/fenceDistance'

/**
 * What the scoring screen opens a game with, built here from the database:
 * the teams as the app's `teamsOf` makes them, the lineups the first record
 * starts from, and the fence the game is played to. Team names and logos are
 * written into no play.
 *
 * Null when no stored play or at-bat carries a GameStation record, so there
 * is nothing GameStation scored to replay.
 */
export async function contextOf(
  db: Kysely<Database>,
  gameId: string,
  game: { home_team_id: string; away_team_id: string },
  stored: StoredGame
): Promise<SessionContext | null> {
  const teams = await db
    .selectFrom('teams')
    .select(['id', 'name', 'logo_path'])
    .where('id', 'in', [game.home_team_id, game.away_team_id])
    .execute()
  const team = (id: string): SessionContext['teams']['home'] => {
    const row = teams.find(item => item.id === id)
    return { id, name: row?.name ?? '', logoUrl: row?.logo_path ?? null }
  }
  const first = [...stored.plays, stored.currentPlay]
    .map(recordOf)
    .find(record => record != null)
  if (first == null) return null
  return {
    gamePk: gameId,
    teams: { away: team(game.away_team_id), home: team(game.home_team_id) },
    setup: first.setupBefore,
    fenceDistanceFt: await fenceDistanceFor(db, gameId)
  }
}
