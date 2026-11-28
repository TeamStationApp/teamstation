import { type Kysely, sql } from 'kysely'

import {
  namedTeamIds,
  OPEN_SIDE_NAME,
  wireSideId
} from '../../common/openSides'
import type { AdminScopes } from '../access'
import type { Database } from '../db/database'

/**
 * The games somebody **runs** — as owner, manager, or an admin of the team,
 * its season or its league — which is who may point a camera at a game,
 * publish its scoreboard or override it. TS Director's picker and the
 * scoreboard's lists both start here.
 */

/** Whether these scopes run a game: a site admin, or either team's admin. */
export function mayRunGame(
  scopes: AdminScopes,
  game: { homeTeamId: string | null; awayTeamId: string | null }
): boolean {
  return (
    scopes.isAdmin ||
    namedTeamIds(game.homeTeamId, game.awayTeamId).some(teamId =>
      scopes.teamIds.has(teamId)
    )
  )
}

// The query's type is what Kysely infers; written out it would be a page.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function gamesWithTeams(db: Kysely<Database>) {
  // An open side joins no team: it is TBD, with the id `''`.
  return db
    .selectFrom('games')
    .leftJoin('teams as home', 'home.id', 'games.home_team_id')
    .leftJoin('teams as away', 'away.id', 'games.away_team_id')
    .select([
      'games.id as id',
      'games.start_at as startAt',
      'games.venue as venue',
      sql<string>`coalesce(games.home_team_id, ${wireSideId(null)})`.as(
        'homeTeamId'
      ),
      sql<string>`coalesce(games.away_team_id, ${wireSideId(null)})`.as(
        'awayTeamId'
      ),
      sql<string>`coalesce(home.name, ${OPEN_SIDE_NAME})`.as('homeTeamName'),
      sql<string>`coalesce(away.name, ${OPEN_SIDE_NAME})`.as('awayTeamName'),
      'home.logo_path as homeLogoPath',
      'away.logo_path as awayLogoPath'
    ])
    .where('games.status', '<>', 'cancelled')
}
export type RunGamesQuery = ReturnType<typeof gamesWithTeams>

/**
 * The games these scopes run that are not cancelled, with both teams, for a
 * caller to narrow by time, order and limit. An administrator of the site
 * sees every game; somebody who runs nothing gets undefined, which is an
 * empty list.
 */
export function runGamesQuery(
  db: Kysely<Database>,
  scopes: AdminScopes
): RunGamesQuery | undefined {
  const query = gamesWithTeams(db)
  if (scopes.isAdmin) return query
  const teamIds = [...scopes.teamIds]
  if (teamIds.length === 0) return undefined
  return query.where(eb =>
    eb.or([
      eb('games.home_team_id', 'in', teamIds),
      eb('games.away_team_id', 'in', teamIds)
    ])
  )
}

export type RunGameRow = Awaited<ReturnType<RunGamesQuery['execute']>>[number]
