import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely'

import { type Role, ROLE_FLAGS, ROLES } from '../common/roles'
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
 * These settings only ever widen *viewing*. What somebody may change is
 * `roleScopes` below: administrators, and the four role flags.
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

/** The leagues, seasons and teams one role reaches, inherited downwards. */
export interface ScopeSet {
  leagueIds: Set<string>
  seasonIds: Set<string>
  teamIds: Set<string>
}

/**
 * Where one person holds each role, worked out once per request.
 *
 * Every flag's sets already include the administrator's, because an admin
 * holds every flag without having one set, so a check reads one set and
 * never two. A site administrator holds every role everywhere, which the
 * sets cannot list: `isAdmin` says so, and `hasRole` reads it first.
 */
export type RoleScopes = Record<Role, ScopeSet> & { isAdmin: boolean }

function emptyScopes(): ScopeSet {
  return { leagueIds: new Set(), seasonIds: new Set(), teamIds: new Set() }
}

/**
 * Each role's rows, carried down: a league's to its seasons and their teams,
 * a season's to its teams. Never upwards.
 *
 * One query per level for every role at once, whatever the number of roles:
 * the seasons of every league anybody holds anything on, then the teams of
 * every season. The sets are filled in place, and returned.
 */
export async function inheritScopes<K extends string>(
  db: Kysely<Database>,
  direct: Record<K, ScopeSet>
): Promise<Record<K, ScopeSet>> {
  const sets = Object.values<ScopeSet>(direct)
  const leagueIds = new Set(sets.flatMap(set => [...set.leagueIds]))
  if (leagueIds.size > 0) {
    const seasons = await db
      .selectFrom('seasons')
      .select(['id', 'league_id'])
      .where('league_id', 'in', [...leagueIds])
      .execute()
    for (const set of sets) {
      for (const row of seasons) {
        if (row.league_id != null && set.leagueIds.has(row.league_id)) {
          set.seasonIds.add(row.id)
        }
      }
    }
  }
  const seasonIds = new Set(sets.flatMap(set => [...set.seasonIds]))
  if (seasonIds.size > 0) {
    const teams = await db
      .selectFrom('season_teams')
      .select(['season_id', 'team_id'])
      .where('season_id', 'in', [...seasonIds])
      .execute()
    for (const set of sets) {
      for (const row of teams) {
        if (set.seasonIds.has(row.season_id)) set.teamIds.add(row.team_id)
      }
    }
  }
  return direct
}

/**
 * Every role this person holds, and where.
 *
 * The `scope_roles` rows, plus a team's owner or manager as that team's
 * administrator, so there is one place to look rather than two. Then each
 * role is carried downwards, and the administrator's sets are added to every
 * flag's.
 */
export async function roleScopes(
  db: Kysely<Database>,
  userId: number,
  isAdmin: boolean
): Promise<RoleScopes> {
  const direct = Object.fromEntries(
    ROLES.map(role => [role, emptyScopes()])
  ) as Record<Role, ScopeSet>

  const rows = await db
    .selectFrom('scope_roles')
    .select(['scope_type', 'scope_id', 'role'])
    .where('user_id', '=', userId)
    .execute()
  for (const row of rows) {
    const set = direct[row.role]
    if (row.scope_type === 'league') set.leagueIds.add(row.scope_id)
    if (row.scope_type === 'season') set.seasonIds.add(row.scope_id)
    if (row.scope_type === 'team') set.teamIds.add(row.scope_id)
  }

  const owned = await db
    .selectFrom('memberships')
    .select(['team_id'])
    .where('user_id', '=', userId)
    .where('role', 'in', ['owner', 'manager'])
    .execute()
  for (const row of owned) direct.admin.teamIds.add(row.team_id)

  const inherited = await inheritScopes(db, direct)
  for (const flag of ROLE_FLAGS) {
    for (const key of ['leagueIds', 'seasonIds', 'teamIds'] as const) {
      for (const id of inherited.admin[key]) inherited[flag][key].add(id)
    }
  }
  return { ...inherited, isAdmin }
}

/**
 * Where this user may change things, including what they inherit downwards.
 *
 * Administrator rows only: a flag grants what it names and never what an
 * administrator may do, so no flag ever widens this.
 */
export async function adminScopes(
  db: Kysely<Database>,
  userId: number,
  isAdmin: boolean
): Promise<AdminScopes> {
  const scopes = await roleScopes(db, userId, isAdmin)
  return { ...scopes.admin, isAdmin }
}

/** Whether these scopes hold `role` on `teamId`. A site admin holds all. */
export function hasRole(
  scopes: RoleScopes,
  role: Role,
  teamId: string
): boolean {
  return scopes.isAdmin || scopes[role].teamIds.has(teamId)
}

/** Scores the team's games: Score Game, and posting plays and lineups. */
export function canScore(scopes: RoleScopes, teamId: string): boolean {
  return hasRole(scopes, 'scorekeeper', teamId)
}

/** Sets the team's walk-up songs and DJs its games. */
export function canKeepSongs(scopes: RoleScopes, teamId: string): boolean {
  return hasRole(scopes, 'songkeeper', teamId)
}

/** Edits the team's players' settings, and sees their whole names. */
export function canCoach(scopes: RoleScopes, teamId: string): boolean {
  return hasRole(scopes, 'coach', teamId)
}

/** Films and streams the team's games, live or uploaded afterwards. */
export function canFilm(scopes: RoleScopes, teamId: string): boolean {
  return hasRole(scopes, 'videographer', teamId)
}

/** The roles these scopes hold on one team, administrator first. */
export function rolesOnTeam(scopes: RoleScopes, teamId: string): Role[] {
  return ROLES.filter(role => hasRole(scopes, role, teamId))
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
 * Whether somebody may **change** a player's name.
 *
 * Narrow by Paul's instruction of 2026-09-19: a site administrator, a parent
 * — a `user_links` row of kind `guardian` or `family` — or the player
 * themselves, whose own name is their own business. A coach may read the
 * whole name (`maySeeFullName`) but not change it, and neither may a season
 * or league administrator.
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

/**
 * Whether somebody may **read** a player's whole name.
 *
 * Everybody else reads `Jensen P`. The whole name goes to whoever may change
 * it, and to a coach or an administrator of a team the player plays on —
 * directly, or through its season or league — because telling two children
 * apart is part of running the team. Keeping score, keeping songs and
 * filming do not need it, and neither does watching.
 */
export async function maySeeFullName(
  db: Kysely<Database>,
  actorUserId: number,
  playerUserId: number,
  about: { isAdmin: boolean }
): Promise<boolean> {
  if (await mayEditName(db, actorUserId, playerUserId, about)) return true
  const scopes = await roleScopes(db, actorUserId, about.isAdmin)
  const teams = await db
    .selectFrom('memberships')
    .select(['team_id'])
    .where('user_id', '=', playerUserId)
    .where('is_player', '=', true)
    .execute()
  return teams.some(row => canCoach(scopes, row.team_id))
}
