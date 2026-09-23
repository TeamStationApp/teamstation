import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely'

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
  userId: number,
  isAdmin: boolean
): Promise<VisibleScopes> {
  const memberships = await db
    .selectFrom('memberships')
    .select(['team_id'])
    .where('user_id', '=', userId)
    .execute()
  const teamIds = new Set(memberships.map(row => row.team_id))

  // Belonging to a season is its own thing: PeerTube's channel allow-list
  // brought 16 people who are on no team but may watch everything in the
  // season, and a season member sees every team in it.
  const seasonMemberships = await db
    .selectFrom('season_members')
    .select(['season_id'])
    .where('user_id', '=', userId)
    .execute()
  const memberSeasonIds = seasonMemberships.map(row => row.season_id)

  // Belonging to a league is the same idea one level up, and is what a
  // league-scoped invite grants. Read as the league's seasons rather than
  // stored as them: a season created next spring is in the league the moment
  // it exists, which a list written down on the day somebody joined would
  // never catch up with.
  const leagueMemberships = await db
    .selectFrom('league_members')
    .select(['league_id'])
    .where('user_id', '=', userId)
    .execute()
  if (leagueMemberships.length > 0) {
    const inThose = await db
      .selectFrom('seasons')
      .select(['id'])
      .where(
        'league_id',
        'in',
        leagueMemberships.map(row => row.league_id)
      )
      .execute()
    for (const row of inThose) memberSeasonIds.push(row.id)
  }

  if (memberSeasonIds.length > 0) {
    const inThose = await db
      .selectFrom('season_teams')
      .select(['team_id'])
      .where('season_id', 'in', memberSeasonIds)
      .execute()
    for (const row of inThose) teamIds.add(row.team_id)
  }

  if (teamIds.size === 0) {
    return { teamIds, seasonIds: new Set(memberSeasonIds), isAdmin }
  }

  // Seasons this user's teams play in, with the season's and league's setting.
  const rows = await db
    .selectFrom('season_teams')
    .innerJoin('seasons', 'seasons.id', 'season_teams.season_id')
    // Left, not inner: a season imported before its league exists still
    // grants what its own setting says.
    .leftJoin('leagues', 'leagues.id', 'seasons.league_id')
    .select([
      'seasons.id as seasonId',
      'seasons.league_id as leagueId',
      'seasons.spectator_access as seasonAccess',
      'leagues.spectator_access as leagueAccess'
    ])
    .where('season_teams.team_id', 'in', [...teamIds])
    .execute()

  const seasonIds = new Set<string>(memberSeasonIds)
  const openLeagueIds = new Set<string>()
  for (const row of rows) {
    if (row.seasonAccess === 'season') seasonIds.add(row.seasonId)
    // A season with no league yet — the migration imports them that way, and
    // Paul attaches them afterwards — simply has no league to inherit from.
    if (row.leagueAccess === 'league' && row.leagueId != null) {
      openLeagueIds.add(row.leagueId)
    }
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
  userId: number,
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

/**
 * `canSeeGame` as a condition on `games`, for a query that lists games rather
 * than checking one. Undefined for an administrator, who sees every game, and
 * a condition that matches nothing for somebody with no team and no season.
 */
export function visibleGamesWhere(
  scopes: VisibleScopes
):
  | ((eb: ExpressionBuilder<Database, 'games'>) => Expression<SqlBool>)
  | undefined {
  if (scopes.isAdmin) return undefined
  const teamIds = [...scopes.teamIds]
  const seasonIds = [...scopes.seasonIds]
  return eb =>
    eb.or([
      ...(teamIds.length === 0
        ? []
        : [
            eb('games.home_team_id', 'in', teamIds),
            eb('games.away_team_id', 'in', teamIds)
          ]),
      ...(seasonIds.length === 0
        ? []
        : [eb('games.season_id', 'in', seasonIds)])
    ])
}

export function canSeeTeam(scopes: VisibleScopes, teamId: string): boolean {
  return scopes.isAdmin || scopes.teamIds.has(teamId)
}

/** A team a person played for, in the season they played for it. */
export interface PlayedFor {
  teamId: string
  seasonId: string | null
}

/** Whether a team a person played for is one this viewer can see. */
export function canSeePlayedFor(
  scopes: VisibleScopes,
  team: PlayedFor
): boolean {
  if (scopes.isAdmin) return true
  if (scopes.teamIds.has(team.teamId)) return true
  return team.seasonId != null && scopes.seasonIds.has(team.seasonId)
}

/**
 * Whether a person may be seen: by themselves, and by anybody who can see a
 * team they have played for, or the season they played for it in.
 */
export function canSeePerson(
  scopes: VisibleScopes,
  isSelf: boolean,
  teams: PlayedFor[]
): boolean {
  return (
    scopes.isAdmin ||
    isSelf ||
    teams.some(team => canSeePlayedFor(scopes, team))
  )
}

export function canManageTeam(scopes: AdminScopes, teamId: string): boolean {
  return scopes.isAdmin || scopes.teamIds.has(teamId)
}

/**
 * Whether somebody may **change** a player's name — and so be shown it in full.
 *
 * The app draws `Jensen P` and nothing else, on every screen, for everybody.
 * There is no viewer who gets the whole name because of who they are: these
 * are children, and a full name on a page a hundred parents can open is a
 * decision nobody made. The one place the surname appears is the field you
 * type it into, which is a different thing from a page you read.
 *
 * So this is an *editing* right, not a viewing one, and it is narrow by
 * Paul's instruction of 2026-09-19: a site administrator, a parent — a
 * `user_links` row of kind `guardian` or `family` — or the player themselves,
 * whose own name is their own business. A coach is deliberately not on this
 * list, and neither is a season or league administrator.
 */
export async function mayEditName(
  db: Kysely<Database>,
  actorUserId: number,
  playerUserId: number,
  about: { isAdmin: boolean }
): Promise<boolean> {
  if (about.isAdmin) return true
  if (actorUserId === playerUserId) return true

  const parent = await db
    .selectFrom('user_links')
    .select(['id'])
    .where('user_id', '=', actorUserId)
    .where('related_user_id', '=', playerUserId)
    .where('kind', 'in', ['guardian', 'family'])
    .executeTakeFirst()
  return parent != null
}
