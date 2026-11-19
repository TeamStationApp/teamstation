import type { Kysely } from 'kysely'

import type { GameIntent } from '../../common/gameApprovals'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { readOnce } from '../db/readOnce'
import { canAdminister } from '../groups/rights'

/** Participation delegates game consent only inside its season, against another member. */
export async function seasonGameConsent(
  db: Kysely<Database>,
  actor: Actor,
  game: GameIntent
): Promise<boolean> {
  if (game.seasonId == null || game.homeTeamId === game.awayTeamId) return false
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
  return members.has(game.homeTeamId) && members.has(game.awayTeamId)
}
