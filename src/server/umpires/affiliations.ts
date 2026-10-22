import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { umpireFamily, type UmpireIdentity } from './context'

/** Resolve only explicit membership or guardianship of players in this game's season. */
export async function umpireAffiliations(
  db: Kysely<Database>,
  leagueId: string
): Promise<
  (
    person: UmpireIdentity,
    seasonId: string
  ) => Promise<Array<{ id: string; name: string }>>
> {
  const rows = await db
    .selectFrom('memberships as m')
    .innerJoin('teams as t', 't.id', 'm.team_id')
    .innerJoin('season_teams as st', 'st.team_id', 't.id')
    .innerJoin('seasons as s', 's.id', 'st.season_id')
    .select(['m.user_id', 'm.is_player', 't.id', 't.name', 'st.season_id'])
    .where('s.league_id', '=', leagueId)
    .where('st.active', '=', true)
    .execute()
  const families = new Map<string, Promise<UmpireIdentity[]>>()
  const results = new Map<string, Array<{ id: string; name: string }>>()
  return async (person, seasonId) => {
    const key = `${person.userId}:${seasonId}`
    const cached = results.get(key)
    if (cached != null) return cached
    let family = families.get(person.userId)
    if (family == null) {
      family = umpireFamily(db, person.userId)
      families.set(person.userId, family)
    }
    const children = new Set(
      (await family)
        .slice(1)
        .filter(p => p.active)
        .flatMap(p => p.userIds)
    )
    const teams = [
      ...new Map(
        rows
          .filter(
            r =>
              r.season_id === seasonId &&
              (person.userIds.includes(r.user_id) ||
                (r.is_player && children.has(r.user_id)))
          )
          .map(r => [r.id, { id: r.id, name: r.name }])
      ).values()
    ].sort((a, b) => {
      const nameOrder = a.name.localeCompare(b.name)
      return nameOrder === 0 ? a.id.localeCompare(b.id) : nameOrder
    })
    results.set(key, teams)
    return teams
  }
}
