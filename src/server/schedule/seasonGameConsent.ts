import type { Kysely } from 'kysely'

import type { GameIntent } from '../../common/gameApprovals'
import { namedTeamIds } from '../../common/openSides'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { readOnce } from '../db/readOnce'
import { canAdminister } from '../groups/rights'

/**
 * Participation delegates game consent only inside its season, against another
 * member. An open side needs no consent: the named sides must each be an
 * active team of the season.
 */
export async function seasonGameConsent(
  db: Kysely<Database>,
  actor: Actor,
  game: GameIntent
): Promise<boolean> {
  const named = namedTeamIds(game.homeTeamId, game.awayTeamId)
  if (game.seasonId == null || (named.length === 2 && named[0] === named[1]))
    return false
  if (!(await canAdminister(db, actor, { kind: 'season', id: game.seasonId })))
    return false
  const seasonId = game.seasonId
  // The season's active teams, read once for all its games.
  const members = await readOnce(
    db,
    `season_teams:${seasonId}:active`,
    async () =>
      new Set(
        (
          await db
            .selectFrom('season_teams')
            .select('team_id')
            .where('season_id', '=', seasonId)
            .where('active', '=', true)
            .execute()
        ).map(row => row.team_id)
      )
  )
  return named.every(teamId => members.has(teamId))
}
