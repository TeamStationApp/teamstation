import type { Kysely } from 'kysely'

import type { GameIntent } from '../../common/gameApprovals'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
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
  const members = await db
    .selectFrom('season_teams')
    .select('team_id')
    .where('season_id', '=', game.seasonId)
    .where('active', '=', true)
    .where('team_id', 'in', [game.homeTeamId, game.awayTeamId])
    .execute()
  return members.length === 2
}
