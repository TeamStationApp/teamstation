import type { Kysely } from 'kysely'

import type { Database } from './db/database'

/**
 * What one person is allowed to see, worked out once per request.
 *
 * The rule, in order:
 *
 * 1. A team's own people always see everything of that team.
 * 2. A season with `spectatorAccess = season` shows every game of that season
 *    to everyone in any of its teams.
 * 3. A league with `spectatorAccess = league` does the same across all its
 *    seasons.
 * 4. Nothing else is visible, and a read that is not allowed answers 404 so
 *    that existence does not leak.
 *
 * These settings only ever widen *viewing*. Editing, uploading and ingesting
 * stay with admins, which is `adminScopes` below.
 */
export interface VisibleScopes {
  /** Teams the user belongs to. */
  teamIds: Set<string>
  /** Seasons opened up to the user, by a season or a league setting. */
  seasonIds: Set<string>
  /** True for a site administrator, who sees everything. */
  isAdmin: boolean
}

export interface AdminScopes {
  leagueIds: Set<string>
  seasonIds: Set<string>
  teamIds: Set<string>
  isAdmin: boolean
}

export async function visibleScopes(
  db: Kysely<Database>,
  userId: string,
  isAdmin: boolean
): Promise<VisibleScopes> {
  const memberships = await db
    .selectFrom('memberships')
    .select(['team_id'])
    .where('user_id', '=', userId)
    .execute()
  const teamIds = new Set(memberships.map(row => row.team_id))

  if (teamIds.size === 0) {
    return { teamIds, seasonIds: new Set(), isAdmin }
  }

  // Seasons this user's teams play in, with the season's and league's setting.
  const rows = await db
    .selectFrom('season_teams')
    .innerJoin('seasons', 'seasons.id', 'season_teams.season_id')
    .innerJoin('leagues', 'leagues.id', 'seasons.league_id')
    .select([
      'seasons.id as seasonId',
      'seasons.league_id as leagueId',
      'seasons.spectator_access as seasonAccess',
      'leagues.spectator_access as leagueAccess'
    ])
    .where('season_teams.team_id', 'in', [...teamIds])
    .execute()

  const seasonIds = new Set<string>()
  const openLeagueIds = new Set<string>()
  for (const row of rows) {
    if (row.seasonAccess === 'season') seasonIds.add(row.seasonId)
    if (row.leagueAccess === 'league') openLeagueIds.add(row.leagueId)
  }

  // A league that has opened itself up brings every one of its seasons, not
  // only the ones this user's teams happen to play in.
  if (openLeagueIds.size > 0) {
    const leagueSeasons = await db
      .selectFrom('seasons')
      .select(['id'])
      .where('league_id', 'in', [...openLeagueIds])
      .execute()
    for (const row of leagueSeasons) seasonIds.add(row.id)
  }

  return { teamIds, seasonIds, isAdmin }
}

/** Where this user may change things, including what they inherit downwards. */
export async function adminScopes(
  db: Kysely<Database>,
  userId: string,
  isAdmin: boolean
): Promise<AdminScopes> {
  const roles = await db
    .selectFrom('admin_roles')
    .select(['scope_type', 'scope_id'])
    .where('user_id', '=', userId)
    .execute()

  const leagueIds = new Set<string>()
  const seasonIds = new Set<string>()
  const teamIds = new Set<string>()
  for (const role of roles) {
    if (role.scope_type === 'league') leagueIds.add(role.scope_id)
    if (role.scope_type === 'season') seasonIds.add(role.scope_id)
    if (role.scope_type === 'team') teamIds.add(role.scope_id)
  }

  // A team's owner or manager is an admin of that team, so there is one place
  // to look rather than two.
  const owned = await db
    .selectFrom('memberships')
    .select(['team_id'])
    .where('user_id', '=', userId)
    .where('role', 'in', ['owner', 'manager'])
    .execute()
  for (const row of owned) teamIds.add(row.team_id)

  // Rights inherit downwards: a league admin administers its seasons and their
  // teams; a season admin administers that season's teams. Never upwards.
  if (leagueIds.size > 0) {
    const seasons = await db
      .selectFrom('seasons')
      .select(['id'])
      .where('league_id', 'in', [...leagueIds])
      .execute()
    for (const row of seasons) seasonIds.add(row.id)
  }
  if (seasonIds.size > 0) {
    const teams = await db
      .selectFrom('season_teams')
      .select(['team_id'])
      .where('season_id', 'in', [...seasonIds])
      .execute()
    for (const row of teams) teamIds.add(row.team_id)
  }

  return { leagueIds, seasonIds, teamIds, isAdmin }
}

export interface GameScope {
  homeTeamId: string
  awayTeamId: string
  seasonId: string | null
}

/** Whether a game, and so its videos, events and stats, may be seen. */
export function canSeeGame(scopes: VisibleScopes, game: GameScope): boolean {
  if (scopes.isAdmin) return true
  if (scopes.teamIds.has(game.homeTeamId)) return true
  if (scopes.teamIds.has(game.awayTeamId)) return true
  if (game.seasonId != null && scopes.seasonIds.has(game.seasonId)) return true
  return false
}

export function canSeeTeam(scopes: VisibleScopes, teamId: string): boolean {
  return scopes.isAdmin || scopes.teamIds.has(teamId)
}

export function canManageTeam(scopes: AdminScopes, teamId: string): boolean {
  return scopes.isAdmin || scopes.teamIds.has(teamId)
}
