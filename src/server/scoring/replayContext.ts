import type { Kysely } from 'kysely'

import { namedTeamIds, OPEN_SIDE_NAME } from '../../common/openSides'
import { recordOf } from '../../common/scoring/gumbo'
import type { SessionContext, StoredGame } from '../../common/scoring/session'
import { teamsOfRow } from '../../common/teamLists'
import type { Database } from '../db/database'
import { fenceDistanceFor } from '../games/fenceDistance'
import type { GameSideIds } from '../games/namedSides'

/**
 * What the scoring screen opens a game with, built here from the database:
 * the teams as the app's `teamsOf` makes them, the lineups the first record
 * starts from, and the fence the game is played to. Team names and logos are
 * written into no play.
 *
 * Null when no stored play or at-bat carries a TeamStation record, so there
 * is nothing TeamStation scored to replay.
 */
export async function contextOf(
  db: Kysely<Database>,
  gameId: string,
  game: GameSideIds,
  stored: StoredGame,
  parts?: ContextParts
): Promise<SessionContext | null> {
  const sides = teamsOfRow(game)
  // The first record is all it needs: nothing later is read here.
  let first: ReturnType<typeof recordOf> = null
  for (const play of [...stored.plays, stored.currentPlay]) {
    first = recordOf(play, sides)
    if (first != null) break
  }
  if (first == null) return null
  const { teams, fenceDistanceFt } =
    parts ?? (await contextParts(db, gameId, game))
  return { gamePk: gameId, teams, setup: first.setupBefore, fenceDistanceFt }
}

/** What a game's context reads besides its plays: the teams and the fence. */
export interface ContextParts {
  teams: SessionContext['teams']
  fenceDistanceFt: SessionContext['fenceDistanceFt']
}

export async function contextParts(
  db: Kysely<Database>,
  gameId: string,
  game: GameSideIds
): Promise<ContextParts> {
  const named = namedTeamIds(game.home_team_id, game.away_team_id)
  const rows =
    named.length === 0
      ? []
      : await db
          .selectFrom('teams')
          .select(['id', 'name', 'logo_path'])
          .where('id', 'in', named)
          .execute()
  // An open side is TBD: no team, so no logo.
  const team = (id: string | null): SessionContext['teams']['home'] => {
    if (id == null) return { id: '', name: OPEN_SIDE_NAME, logoUrl: null }
    const row = rows.find(item => item.id === id)
    return { id, name: row?.name ?? '', logoUrl: row?.logo_path ?? null }
  }
  return {
    teams: { away: team(game.away_team_id), home: team(game.home_team_id) },
    fenceDistanceFt: await fenceDistanceFor(db, gameId)
  }
}
