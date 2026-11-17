import type { Kysely } from 'kysely'

import type { GroupRef } from '../../common/groupCreation'
import { hierarchyReady, levelsAboveTeam } from '../access'
import { anyOf } from '../db/anyOf'
import type { Database } from '../db/database'

/**
 * The leagues and seasons whose administrators reach a child, as
 * `inheritScopes` carries them down: a season's league; a team's
 * `levelsAboveTeam`.
 */
async function ancestorsOf(
  db: Kysely<Database>,
  ref: GroupRef
): Promise<{ leagueIds: string[]; seasonIds: string[] }> {
  if (ref.kind === 'team') return await levelsAboveTeam(db, ref.id)
  const season = await db
    .selectFrom('seasons')
    .select('league_id')
    .where('id', '=', ref.id)
    .executeTakeFirst()
  return {
    leagueIds: season?.league_id == null ? [] : [season.league_id],
    seasonIds: []
  }
}

/**
 * Active organizational administrators whose authority reaches a child,
 * through the permission parents `roleScopes` reads.
 *
 * `durable` keeps only coverage the ownership cutover cannot take away: what
 * creation may rely on in place of a direct grant, and what keeps a group
 * administered when its last direct administrator goes. Before the cutover a
 * team's parents are its competition seasons, and the cutover may choose
 * another parent or league for it, so a team then has none.
 */
export async function inheritedAdminIds(
  db: Kysely<Database>,
  ref: GroupRef,
  options: { userId?: string; durable?: boolean } = {}
): Promise<string[]> {
  const { userId, durable = false } = options
  if (ref.kind === 'league') return []
  if (durable && ref.kind === 'team' && !(await hierarchyReady(db))) return []
  const { leagueIds, seasonIds } = await ancestorsOf(db, ref)
  if (leagueIds.length === 0 && seasonIds.length === 0) return []
  let query = db
    .selectFrom('scope_roles')
    .innerJoin('users', 'users.id', 'scope_roles.user_id')
    .select('user_id')
    .distinct()
    .where('role', '=', 'admin')
    .where(eb =>
      eb.or([
        ...(leagueIds.length > 0
          ? [
              eb.and([
                eb('scope_type', '=', 'league'),
                eb('scope_id', '=', anyOf(leagueIds))
              ])
            ]
          : []),
        ...(seasonIds.length > 0
          ? [
              eb.and([
                eb('scope_type', '=', 'season'),
                eb('scope_id', '=', anyOf(seasonIds))
              ])
            ]
          : [])
      ])
    )
    .where('users.login_enabled', '=', true)
    .where('users.disabled_at', 'is', null)
    .where('users.merged_into', 'is', null)
  if (userId != null) query = query.where('user_id', '=', userId)
  return (await query.execute()).map(row => row.user_id).sort()
}
