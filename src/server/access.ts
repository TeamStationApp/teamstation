import {
  type Expression,
  type ExpressionBuilder,
  type Kysely,
  sql,
  type SqlBool
} from 'kysely'

import { type Role, ROLE_FLAGS, ROLES } from '../common/roles'
import { type OnePerson, onePerson } from './admin/people'
import type { Database } from './db/database'

/**
 * What one person is allowed to see, worked out once per request.
 *
 * Own-team memberships and genuine management roles grant team visibility.
 * Explicit season/league viewing memberships are bounded to those seasons'
 * games. Competition membership and raw game invitations grant no private
 * scope. Public summaries are separate from these private permissions.
 */
export interface VisibleScopes {
  /** Teams the user belongs to. */
  teamIds: Set<string>
  /** Explicit season/league viewing grants and true parent roles. */
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
  const user = await db
    .selectFrom('users')
    .select(['disabled_at', 'merged_into'])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (user == null || user.disabled_at != null || user.merged_into != null)
    return { teamIds: new Set(), seasonIds: new Set(), isAdmin: false }
  const memberships = await db
    .selectFrom('memberships')
    .select(['team_id'])
    .where('user_id', '=', userId)
    .execute()
  const teamIds = new Set(memberships.map(row => row.team_id))

  // Belonging to a season is its own thing: PeerTube's channel allow-list
  // brought people who are on no team but may watch everything in the
  // season, bounded to its games rather than every team's unrelated data.
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

  // Only actual memberships and true management roles supply private scopes.
  // Competition links never widen spectator access, even when a host opens itself.
  const roles = await roleScopes(db, userId, isAdmin)
  for (const role of ROLES) {
    for (const teamId of roles[role].teamIds) teamIds.add(teamId)
    memberSeasonIds.push(...roles[role].seasonIds)
  }
  return {
    teamIds,
    seasonIds: new Set(memberSeasonIds),
    isAdmin: roles.isAdmin
  }
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
  if (leagueIds.size > 0) {
    const leagueTeams = await db
      .selectFrom('teams')
      .select(['id', 'league_id'])
      .where('league_id', 'in', [...leagueIds])
      .execute()
    for (const set of sets)
      for (const team of leagueTeams) {
        if (team.league_id != null && set.leagueIds.has(team.league_id))
          set.teamIds.add(team.id)
      }
  }
  const seasonIds = new Set(sets.flatMap(set => [...set.seasonIds]))
  if (seasonIds.size > 0) {
    // The flag and selected edges use one statement snapshot: schema upgrade
    // preserves legacy access until explicit ownership classification commits.
    // New competition writers are gated by that same atomic cutover.
    const ready = db
      .selectFrom('system_settings')
      .select('key')
      .where('key', '=', 'creation.hierarchyReady')
      .where(sql<boolean>`value = 'true'::jsonb`)
    const parents = db
      .selectFrom('season_team_parents')
      .select(['season_id', 'team_id'])
      .where(eb => eb.exists(ready))
      .unionAll(
        db
          .selectFrom('season_teams')
          .select(['season_id', 'team_id'])
          .where(eb => eb.not(eb.exists(ready)))
      )
      .as('permission_parents')
    const teams = await db
      .selectFrom(parents)
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
  _isAdmin: boolean
): Promise<RoleScopes> {
  const direct = Object.fromEntries(
    ROLES.map(role => [role, emptyScopes()])
  ) as Record<Role, ScopeSet>
  const user = await db
    .selectFrom('users')
    .select(['is_admin', 'disabled_at', 'merged_into'])
    .where('id', '=', userId)
    .executeTakeFirst()
  if (user == null || user.disabled_at != null || user.merged_into != null)
    return { ...direct, isAdmin: false }

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
  return { ...inherited, isAdmin: user.is_admin }
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
  return { ...scopes.admin, isAdmin: scopes.isAdmin }
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
  return scopes.isAdmin || scopes.teamIds.has(team.teamId)
}

/**
 * Whether a person may be seen: by themselves, and by anybody who can see a
 * private team they have played for. Season viewing is bounded to games and
 * cannot reveal a player's profile or external identity.
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
 * Whether somebody may see and **change** a player's whole name.
 *
 * A site administrator, a parent — a `user_links` row of kind `guardian` or
 * `family` — the player themselves, whose own name is their own business,
 * and the staff of a team the person plays for: anybody holding any role on
 * it, an administrator, coach, scorekeeper, songkeeper or videographer, set
 * on the team or carried down from its season or league, and its owner or
 * manager. Paul, 2026-10-02: team admins, coaches and other staff can see
 * and edit a child's full name.
 *
 * This is also the only way to **read** the whole name: it is sent nowhere
 * but `GET /players/:userId/name`, which this guards. Everything else — the
 * roster, the player page, the box score — carries `Jordan P` alone.
 *
 * A parent's link and the player's team rows are read across every row of
 * each person, not one id each. A merge closes a row into another and leaves
 * what was written about it where it was, so a parent's link names the row
 * their child had when it was made, and may hang from a row of the parent's
 * own that has since been closed into the one they sign in as. Asking about
 * one id each cost `Mookie Betts`'s parents his name the day the placeholder
 * row they were linked to was merged into his real one. Asked across every
 * row, undoing a merge takes the parent's answer back with it: no link was
 * copied that would have to be found and removed. Team rows are another
 * matter: `closeInto` moves them onto the row it keeps, and a split leaves them
 * there, so the staff answer stays where the merge put it.
 *
 * That makes the name follow a merge, right or wrong. A merge says two rows
 * are one person, and while a wrong one stands both sides of it are one:
 *
 * - Two boys called `Nolan` on one team: the parents of each can read the
 *   other's surname, as every other read already treats the two as one, until
 *   `repair-people` splits them at a game they both played in.
 * - Two parents who share a name, closed together by `same-person`: each can
 *   read the names of the other's children, and a father closed together with
 *   a son of the same name is taken for the son himself. Adults have no plays,
 *   so `repair-people` never finds the clash; such a merge is undone by hand.
 *
 * The staff's roles are still read from the row the asker is signed in as, the
 * way every other rule here reads them.
 *
 * A caller that has already gathered the player's rows passes them as
 * `known.player`, so a page does not walk the same chain twice. Rows that do
 * not include `playerUserId` are somebody else's and are not used.
 */
export async function mayEditName(
  db: Kysely<Database>,
  actorUserId: number,
  playerUserId: number,
  about: { isAdmin: boolean },
  known: { player?: OnePerson } = {}
): Promise<boolean> {
  if (about.isAdmin) return true
  if (actorUserId === playerUserId) return true

  const gathered =
    known.player?.userIds.includes(playerUserId) === true
      ? known.player
      : undefined
  const [actor, player] = await Promise.all([
    onePerson(db, actorUserId),
    gathered ?? onePerson(db, playerUserId)
  ])
  // The asker's own row among the player's rows is the player themselves.
  // Comparing where the two walks stopped is not enough: rows closed into
  // each other stop each walk on the other row.
  if (player.userIds.includes(actorUserId)) return true

  const parent = await db
    .selectFrom('user_links')
    .select(['id'])
    .where('user_id', 'in', actor.userIds)
    .where('related_user_id', 'in', player.userIds)
    .where('kind', 'in', ['guardian', 'family'])
    .executeTakeFirst()
  if (parent != null) return true

  const scopes = await roleScopes(db, actorUserId, false)
  const staffOf = new Set(ROLES.flatMap(role => [...scopes[role].teamIds]))
  if (staffOf.size === 0) return false
  const plays = await db
    .selectFrom('memberships')
    .select(['id'])
    .where('user_id', 'in', player.userIds)
    .where('is_player', '=', true)
    .where('team_id', 'in', [...staffOf])
    .executeTakeFirst()
  return plays != null
}
