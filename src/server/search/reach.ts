import { type Kysely, sql } from 'kysely'

import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'

/**
 * The leagues, seasons and teams a reader's search can find people in: their
 * own groups, never the ones they only follow.
 *
 * - **Teams:** every team they hold a membership on (any role, spectators
 *   included) or a team role on, and the teams of the players they are a
 *   guardian of.
 * - **Seasons:** every season they are a member of or hold a season role on,
 *   and the managing season of each of those teams.
 * - **Leagues:** every league they are a member of or hold a league role on,
 *   and the league of each of those teams and seasons.
 *
 * A signed-out reader's reach is empty.
 */
export interface SearchReach {
  teamIds: Set<string>
  seasonIds: Set<string>
  leagueIds: Set<string>
}

export function emptyReach(): SearchReach {
  return { teamIds: new Set(), seasonIds: new Set(), leagueIds: new Set() }
}

/** Whether a group is one of the reader's own. */
export function inReach(
  reach: SearchReach,
  kind: 'league' | 'season' | 'team',
  id: string
): boolean {
  const ids =
    kind === 'league'
      ? reach.leagueIds
      : kind === 'season'
        ? reach.seasonIds
        : reach.teamIds
  return ids.has(id)
}

/**
 * The reader's reach. With `forTeam`, as Add Existing Player asks, it also
 * holds that team, its managing season, every season it plays in (an active
 * `season_teams` row, such as a tournament another league runs), the game's
 * season (`forSeason`), and their leagues: `candidateTarget` has checked by
 * then that the reader may add players there.
 */
export async function searchReach(
  db: Kysely<Database>,
  actor: Actor | null,
  forTeam?: string,
  forSeason?: string | null
): Promise<SearchReach> {
  const reach = emptyReach()
  if (actor == null) return reach
  const userId = actor.userId
  const extra =
    forTeam == null ? sql`` : sql`union select ${forTeam}::text as id`
  const targetSeasons =
    forTeam == null
      ? sql``
      : sql`union
      select season_id from season_teams
        where active and team_id = ${forTeam}
      ${forSeason == null ? sql`` : sql`union select ${forSeason}::text`}`
  const { rows } = await sql<{
    kind: 'team' | 'season' | 'league'
    id: string
  }>`
    with
    guarded as (
      select related_user_id as id from user_links
        where user_id = ${userId} and kind = 'guardian'
    ),
    own_teams as (
      select team_id as id from memberships where user_id = ${userId}
      union
      select scope_id from scope_roles
        where user_id = ${userId} and scope_type = 'team'
      union
      select team_id from memberships
        where user_id in (select id from guarded)
      ${extra}
    ),
    live_teams as (
      select t.id, t.league_id from teams t
        where t.id in (select id from own_teams) and t.merged_into is null
    ),
    own_seasons as (
      select season_id as id from season_members where user_id = ${userId}
      union
      select scope_id from scope_roles
        where user_id = ${userId} and scope_type = 'season'
      union
      select season_id from season_team_parents
        where team_id in (select id from live_teams)
      ${targetSeasons}
    ),
    own_leagues as (
      select league_id as id from league_members where user_id = ${userId}
      union
      select scope_id from scope_roles
        where user_id = ${userId} and scope_type = 'league'
      union
      select league_id from live_teams where league_id is not null
      union
      select league_id from seasons
        where id in (select id from own_seasons) and league_id is not null
    )
    select 'team' as kind, id from live_teams
    union all
    select 'season', id from own_seasons
    union all
    select 'league', id from own_leagues
  `.execute(db)
  for (const row of rows)
    (row.kind === 'team'
      ? reach.teamIds
      : row.kind === 'season'
        ? reach.seasonIds
        : reach.leagueIds
    ).add(row.id)
  return reach
}
