import {
  type AliasedSelectQueryBuilder,
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
 * Membership at any level, genuine management roles and a guardian's child's
 * current teams grant team visibility. A member is the same at every level:
 * a season's member is a member of every team in the season, and a league's
 * of every team in the league and in its seasons, as roles flow down.
 * Competition membership and raw game invitations grant no private scope.
 * Public summaries are separate from these private permissions.
 */
export interface VisibleScopes {
  /**
   * Teams the user is a member of — directly, or through a season or league
   * they are a member of — or holds a role on, or their guarded child plays
   * on now.
   */
  teamIds: Set<string>
  /** The seasons they are a member of or hold a role on, and their leagues'. */
  seasonIds: Set<string>
  /** True for a site administrator, who sees everything. */
  isAdmin: boolean
  /**
   * The open rows of everybody this person guards, read once with the rest,
   * so a route that asks `guardsPerson` reads them no second time. Absent
   * from scopes made by hand.
   */
  guardedIds?: ReadonlySet<number>
}

/**
 * Everybody this person is a parent of — a `user_links` row of kind
 * `guardian` or `family` — each as every row they are.
 *
 * Read across every row of both people, as `mayEditName` reads them: a link
 * names the rows the two had when it was made, and either may since have been
 * closed into another.
 */
async function guardedPeople(
  db: Kysely<Database>,
  userId: number
): Promise<OnePerson[]> {
  const actor = await onePerson(db, userId)
  const links = await db
    .selectFrom('user_links')
    .select(['related_user_id'])
    .where('user_id', 'in', actor.userIds)
    .where('kind', 'in', ['guardian', 'family'])
    .execute()
  const people = new Map<number, OnePerson>()
  for (const relatedId of new Set(links.map(row => row.related_user_id))) {
    const child = await onePerson(db, relatedId)
    // Somebody closed into the asker is the asker, not their child.
    if (child.userIds.some(id => actor.userIds.includes(id))) continue
    people.set(child.userId, child)
  }
  return [...people.values()].sort((a, b) => a.userId - b.userId)
}

/**
 * Every row of everybody this person is a guardian of, as a guardian
 * request's terms may name them, in no particular order.
 */
export async function guardedRows(
  db: Kysely<Database>,
  userId: number
): Promise<number[]> {
  return (await guardedPeople(db, userId)).flatMap(child => child.userIds)
}

/**
 * The players this person is a guardian of, by the row each signs in as:
 * every person a `guardian` or `family` link relates to any of the asker's
 * rows, in user id order.
 */
export async function guardedPlayers(
  db: Kysely<Database>,
  userId: number
): Promise<number[]> {
  return (await guardedPeople(db, userId)).map(child => child.userId)
}

/** However deep a chain of merges can go, as `onePerson` walks it. */
const MAX_MERGE_DEPTH = 16

/**
 * `onePerson` for several rows at once, in one query: each row asked about,
 * keyed by itself, as the open row it is now and every row closed into that
 * one. Walks the merges the way `onePerson` does: up to whoever is still open,
 * stopping at a loop or after `MAX_MERGE_DEPTH` steps, then back down.
 */
async function peopleOf(
  db: Kysely<Database>,
  userIds: readonly number[]
): Promise<Map<number, OnePerson>> {
  const asked = [...new Set(userIds)]
  const people = new Map<number, OnePerson>()
  if (asked.length === 0) return people
  const { rows } = await sql<{ start: number; survivor: number; id: number }>`
    with recursive up(start, id, depth, path) as (
      select asked.id, asked.id, 0, array[asked.id]
      from unnest(${asked}::bigint[]) as asked(id)
      union all
      select up.start, users.merged_into, up.depth + 1,
        up.path || users.merged_into
      from up
      inner join users on users.id = up.id
      where users.merged_into is not null
        and not users.merged_into = any(up.path)
        and up.depth < ${MAX_MERGE_DEPTH}
    ),
    survivor(start, id) as (
      select distinct on (start) start, id from up order by start, depth desc
    ),
    down(start, id, depth) as (
      select start, id, 0 from survivor
      union
      select down.start, users.id, down.depth + 1
      from down
      inner join users on users.merged_into = down.id
      where down.depth < ${MAX_MERGE_DEPTH}
    )
    select down.start, survivor.id as survivor, down.id
    from down
    inner join survivor on survivor.start = down.start
    group by down.start, survivor.id, down.id
    order by down.start, min(down.depth), down.id
  `.execute(db)
  for (const row of rows) {
    const person = people.get(row.start)
    if (person == null)
      people.set(row.start, { userId: row.survivor, userIds: [row.id] })
    else person.userIds.push(row.id)
  }
  return people
}

/**
 * The guardians of these players, by the row each signs in as: everybody
 * whose `guardian` or `family` link relates them to any row of any of the
 * players, in user id order. The reverse of `guardedPlayers`, read the same
 * way: a link from a row closed into the player is the player, not a parent.
 * A disabled account is nobody's guardian here. With `signsIn`, neither is
 * an account that cannot sign in (`login_enabled` false, as a roster import
 * makes a parent with no address) or that is closed into another: see
 * `guardiansWhoCanAct`.
 *
 * A handful of queries however many players there are: the players' merges,
 * the links to all of their rows, and the merges of everybody linked, each
 * read once for the whole set.
 */
export async function guardiansOf(
  db: Kysely<Database>,
  playerUserIds: readonly number[],
  { signsIn = false }: { signsIn?: boolean } = {}
): Promise<number[]> {
  const players = [...(await peopleOf(db, playerUserIds)).values()]
  if (players.length === 0) return []
  const links = await db
    .selectFrom('user_links')
    .select(['user_id', 'related_user_id'])
    .where(
      'related_user_id',
      'in',
      players.flatMap(player => player.userIds)
    )
    .where('kind', 'in', ['guardian', 'family'])
    .execute()
  if (links.length === 0) return []
  const parents = await peopleOf(
    db,
    links.map(link => link.user_id)
  )
  const guardians = new Set<number>()
  for (const player of players)
    for (const link of links) {
      if (!player.userIds.includes(link.related_user_id)) continue
      const parent = parents.get(link.user_id)!
      if (parent.userIds.some(id => player.userIds.includes(id))) continue
      guardians.add(parent.userId)
    }
  if (guardians.size === 0) return []
  const enabled = await db
    .selectFrom('users')
    .select('id')
    .where('id', 'in', [...guardians])
    .where('disabled_at', 'is', null)
    .$if(signsIn, query =>
      query.where('login_enabled', '=', true).where('merged_into', 'is', null)
    )
    .orderBy('id')
    .execute()
  return enabled.map(row => row.id)
}

/**
 * The guardians who hold the say over who else becomes one of these players'
 * guardians: `guardiansOf` counting only accounts that can sign in to invite
 * or approve. A parent a roster import made without an address is listed
 * among the family but takes no say from the team's staff; nor does anybody
 * else who cannot sign in.
 */
export async function guardiansWhoCanAct(
  db: Kysely<Database>,
  playerUserIds: readonly number[]
): Promise<number[]> {
  return await guardiansOf(db, playerUserIds, { signsIn: true })
}

/**
 * `guardsPlayer` for a route that has the asker's `visibleScopes` and the
 * player as `onePerson` read them: from the guarded people already read.
 */
export async function guardsPerson(
  db: Kysely<Database>,
  scopes: VisibleScopes,
  actorUserId: number,
  player: OnePerson
): Promise<boolean> {
  const guarded =
    scopes.guardedIds ?? new Set(await guardedPlayers(db, actorUserId))
  return guarded.has(player.userId)
}

/** Whether `actorUserId` is a guardian of any row of `playerUserId`. */
export async function guardsPlayer(
  db: Kysely<Database>,
  actorUserId: number,
  playerUserId: number
): Promise<boolean> {
  const player = await onePerson(db, playerUserId)
  const guarded = await guardedPlayers(db, actorUserId)
  return guarded.includes(player.userId)
}

/**
 * Whether somebody may change a player's details: the jersey and positions
 * on a team, how they bat and throw, and their walk-up song.
 *
 * A site administrator, and a guardian of the player wherever they are
 * asked. With a team, whoever manages that team's roster — a coach,
 * assistant or scorekeeper of it, or its administrator (`canManageRoster`);
 * without one, whoever manages the roster of any team the player plays on,
 * by any of their rows.
 */
export async function mayManagePlayer(
  db: Kysely<Database>,
  actor: { userId: number; isAdmin: boolean },
  playerUserId: number,
  teamId: string | null
): Promise<boolean> {
  if (actor.isAdmin) return true
  if (await guardsPlayer(db, actor.userId, playerUserId)) return true
  const scopes = await roleScopes(db, actor.userId, actor.isAdmin)
  if (teamId != null) return canManageRoster(scopes, teamId)
  const player = await onePerson(db, playerUserId)
  const plays = await teamsPlayedOnNow(db, player.userIds)
  return plays.some(teamId => canManageRoster(scopes, teamId))
}

/**
 * The teams any of these rows plays on now: a player's membership of a team
 * that has not been merged into another, each team once, in no particular
 * order. The one reading of "plays on now" that guardian visibility, player
 * management, guardian invitations and a player's `current` teams share.
 */
export async function teamsPlayedOnNow(
  db: Kysely<Database>,
  userIds: readonly number[]
): Promise<string[]> {
  if (userIds.length === 0) return []
  const plays = await db
    .selectFrom('memberships')
    .innerJoin('teams', 'teams.id', 'memberships.team_id')
    .select(['memberships.team_id'])
    .distinct()
    .where('memberships.user_id', 'in', userIds)
    .where('memberships.is_player', '=', true)
    .where('teams.merged_into', 'is', null)
    .execute()
  return plays.map(row => row.team_id)
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
    return {
      teamIds: new Set(),
      seasonIds: new Set(),
      isAdmin: false,
      guardedIds: new Set()
    }
  const memberships = await db
    .selectFrom('memberships')
    .select(['team_id'])
    .where('user_id', '=', userId)
    .execute()
  const teamIds = new Set(memberships.map(row => row.team_id))

  // A member of a season or a league is the same member a team has, of every
  // team below it, carried down as a role is: a league's seasons and teams,
  // each season's teams. Read as the teams there now rather than stored, so a
  // season created next spring is in the league the moment it exists. Read
  // across every row of the person, because a merge moves team memberships
  // onto the row kept but leaves these where they were written.
  const actor = await onePerson(db, userId)
  const seasonMemberships = await db
    .selectFrom('season_members')
    .select(['season_id'])
    .where('user_id', 'in', actor.userIds)
    .execute()
  const leagueMemberships = await db
    .selectFrom('league_members')
    .select(['league_id'])
    .where('user_id', 'in', actor.userIds)
    .execute()
  const { member } = await inheritScopes(db, {
    member: {
      leagueIds: new Set(leagueMemberships.map(row => row.league_id)),
      seasonIds: new Set(seasonMemberships.map(row => row.season_id)),
      teamIds: new Set<string>()
    }
  })
  for (const teamId of member.teamIds) teamIds.add(teamId)
  const memberSeasonIds = [...member.seasonIds]

  // A guardian is a member of every team their child plays on, for as long
  // as the child does: read from the child's memberships now, never written
  // down, so leaving a team takes it away again unless the guardian belongs
  // to it themselves.
  const guarded = await guardedPeople(db, userId)
  const guardedIds = new Set(guarded.map(child => child.userId))
  const childRows = guarded.flatMap(child => child.userIds)
  for (const teamId of await teamsPlayedOnNow(db, childRows))
    teamIds.add(teamId)

  // Only actual memberships and true management roles supply private scopes.
  // Competition links never widen a member's access, even when a host opens
  // itself.
  const roles = await roleScopes(db, userId, isAdmin)
  for (const role of ROLES) {
    for (const teamId of roles[role].teamIds) teamIds.add(teamId)
    memberSeasonIds.push(...roles[role].seasonIds)
  }
  return {
    teamIds,
    seasonIds: new Set(memberSeasonIds),
    isAdmin: roles.isAdmin,
    guardedIds
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
 * Which seasons a team's roles come down from, as `season_id`/`team_id` rows.
 *
 * The flag and selected edges use one statement snapshot: schema upgrade
 * preserves legacy access until explicit ownership classification commits.
 * New competition writers are gated by that same atomic cutover.
 */
function permissionParents(
  db: Kysely<Database>
): AliasedSelectQueryBuilder<
  { season_id: string; team_id: string },
  'permission_parents'
> {
  const ready = db
    .selectFrom('system_settings')
    .select('key')
    .where('key', '=', 'creation.hierarchyReady')
    .where(sql<boolean>`value = 'true'::jsonb`)
  return db
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
    const teams = await db
      .selectFrom(permissionParents(db))
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
 * role is carried downwards, the administrator's sets are added to every
 * flag's, and the scorekeeper's to the songkeeper's: a scorekeeper holds
 * everything a songkeeper does, never the other way round.
 *
 * These are the roles a person may **use**. The roles they were **given**,
 * which is what a list of staff shows, are `givenRolesOnTeam`.
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
  for (const key of ['leagueIds', 'seasonIds', 'teamIds'] as const) {
    for (const id of inherited.scorekeeper[key])
      inherited.songkeeper[key].add(id)
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

/** Sets the team's walk-up songs and DJs its games; every scorekeeper does. */
export function canKeepSongs(scopes: RoleScopes, teamId: string): boolean {
  return hasRole(scopes, 'songkeeper', teamId)
}

/**
 * Coaches the team: a coach or an assistant, who may do everything a coach
 * may. Editing the team's players' settings and seeing their whole names
 * reaches scorekeepers too: see `canManageRoster`.
 */
export function canCoach(scopes: RoleScopes, teamId: string): boolean {
  return (
    hasRole(scopes, 'coach', teamId) || hasRole(scopes, 'assistant', teamId)
  )
}

/** Scorekeepers can edit player settings and view full names because they
 * may be the only person responsible for maintaining the team roster.
 * This intentional roster-management exception must survive broader
 * permission changes; it does not grant unrelated coaching operations.
 */
export function canManageRoster(scopes: RoleScopes, teamId: string): boolean {
  return canCoach(scopes, teamId) || canScore(scopes, teamId)
}

/** Films and streams the team's games, live or uploaded afterwards. */
export function canFilm(scopes: RoleScopes, teamId: string): boolean {
  return hasRole(scopes, 'videographer', teamId)
}

/**
 * The roles these scopes hold on one team, administrator first: every role
 * the person may use there, so an administrator lists every flag and a
 * scorekeeper lists songkeeper too.
 */
export function rolesOnTeam(scopes: RoleScopes, teamId: string): Role[] {
  return ROLES.filter(role => hasRole(scopes, role, teamId))
}

/**
 * The roles each person was **given** on one team, keyed by user id, each
 * list in `ROLES` order: their `scope_roles` rows on the team, on the seasons
 * it belongs to and on its league, and `admin` for its owner or manager.
 *
 * Unlike `rolesOnTeam`, nothing is implied: an administrator is listed as
 * `admin` alone and a scorekeeper as `scorekeeper` alone, which is what a
 * list of a team's staff shows. Disabled and merged accounts are left out,
 * as they hold no role at all. A site administrator is not listed for
 * holding every role everywhere.
 */
export async function givenRolesOnTeam(
  db: Kysely<Database>,
  teamId: string
): Promise<Map<number, Role[]>> {
  const levels = await givenRoleLevelsOnTeam(db, teamId)
  return new Map(
    [...levels].map(([userId, held]) => [userId, [...held.keys()]])
  )
}

/** Where a role was given, from the team up. */
export type RoleLevel = 'team' | 'season' | 'league'

/**
 * The seasons a team's roles and members come down from, and their leagues
 * with the team's own: the other side of what `inheritScopes` carries down.
 */
async function levelsAboveTeam(
  db: Kysely<Database>,
  teamId: string
): Promise<{ seasonIds: string[]; leagueIds: string[] }> {
  const seasons = await db
    .selectFrom(permissionParents(db))
    .innerJoin('seasons', 'seasons.id', 'permission_parents.season_id')
    .select(['seasons.id', 'seasons.league_id'])
    .where('permission_parents.team_id', '=', teamId)
    .execute()
  const team = await db
    .selectFrom('teams')
    .select('league_id')
    .where('id', '=', teamId)
    .executeTakeFirst()
  const leagueIds = new Set<string>()
  if (team?.league_id != null) leagueIds.add(team.league_id)
  for (const season of seasons)
    if (season.league_id != null) leagueIds.add(season.league_id)
  return {
    seasonIds: seasons.map(season => season.id),
    leagueIds: [...leagueIds]
  }
}

/**
 * Everybody a season or league above the team makes a member of it, as
 * `visibleScopes` reads it from their side, keyed by the row each signs in
 * as, with the highest level that does: a member of both the season and its
 * league is a league member here. A membership written under a row since
 * closed into another is the open row's; a disabled account is left out.
 */
export async function membersAboveTeam(
  db: Kysely<Database>,
  teamId: string
): Promise<Map<number, Exclude<RoleLevel, 'team'>>> {
  const { seasonIds, leagueIds } = await levelsAboveTeam(db, teamId)
  const rows = [
    ...(seasonIds.length === 0
      ? []
      : (
          await db
            .selectFrom('season_members')
            .select('user_id')
            .where('season_id', 'in', seasonIds)
            .execute()
        ).map(row => ({ userId: row.user_id, level: 'season' as const }))),
    ...(leagueIds.length === 0
      ? []
      : (
          await db
            .selectFrom('league_members')
            .select('user_id')
            .where('league_id', 'in', leagueIds)
            .execute()
        ).map(row => ({ userId: row.user_id, level: 'league' as const })))
  ]
  const people = await peopleOf(
    db,
    rows.map(row => row.userId)
  )
  const survivors = [...new Set([...people.values()].map(p => p.userId))]
  const open =
    survivors.length === 0
      ? new Set<number>()
      : new Set(
          (
            await db
              .selectFrom('users')
              .select('id')
              .where('id', 'in', survivors)
              .where('disabled_at', 'is', null)
              .where('merged_into', 'is', null)
              .execute()
          ).map(row => row.id)
        )
  const members = new Map<number, Exclude<RoleLevel, 'team'>>()
  for (const row of rows) {
    const userId = people.get(row.userId)?.userId ?? row.userId
    if (!open.has(userId)) continue
    if (members.get(userId) !== 'league') members.set(userId, row.level)
  }
  return members
}

const LEVEL_RANK: Record<RoleLevel, number> = { team: 0, season: 1, league: 2 }

/**
 * `givenRolesOnTeam` with, for each role, the highest level that gives it:
 * a coach of the team who also coaches its league is a league coach here.
 * Each person's roles are in `ROLES` order. An owner's or manager's `admin`
 * is the team's.
 */
export async function givenRoleLevelsOnTeam(
  db: Kysely<Database>,
  teamId: string
): Promise<Map<number, Map<Role, RoleLevel>>> {
  const { seasonIds, leagueIds } = await levelsAboveTeam(db, teamId)

  const rows = await db
    .selectFrom('scope_roles')
    .innerJoin('users', 'users.id', 'scope_roles.user_id')
    .select([
      'scope_roles.user_id',
      'scope_roles.role',
      'scope_roles.scope_type'
    ])
    .where('users.disabled_at', 'is', null)
    .where('users.merged_into', 'is', null)
    .where(eb =>
      eb.or([
        eb.and([
          eb('scope_roles.scope_type', '=', 'team'),
          eb('scope_roles.scope_id', '=', teamId)
        ]),
        ...(seasonIds.length === 0
          ? []
          : [
              eb.and([
                eb('scope_roles.scope_type', '=', 'season'),
                eb('scope_roles.scope_id', 'in', seasonIds)
              ])
            ]),
        ...(leagueIds.length === 0
          ? []
          : [
              eb.and([
                eb('scope_roles.scope_type', '=', 'league'),
                eb('scope_roles.scope_id', 'in', leagueIds)
              ])
            ])
      ])
    )
    .execute()
  const owners = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select('memberships.user_id')
    .where('memberships.team_id', '=', teamId)
    .where('memberships.role', 'in', ['owner', 'manager'])
    .where('users.disabled_at', 'is', null)
    .where('users.merged_into', 'is', null)
    .execute()

  const held = new Map<number, Map<Role, RoleLevel>>()
  const give = (userId: number, role: Role, level: RoleLevel): void => {
    const roles = held.get(userId) ?? new Map<Role, RoleLevel>()
    const before = roles.get(role)
    if (before == null || LEVEL_RANK[level] > LEVEL_RANK[before])
      roles.set(role, level)
    held.set(userId, roles)
  }
  for (const row of rows) give(row.user_id, row.role, row.scope_type)
  for (const row of owners) give(row.user_id, 'admin', 'team')
  return new Map(
    [...held].map(([userId, roles]) => [
      userId,
      new Map(
        ROLES.flatMap(role => {
          const level = roles.get(role)
          return level == null ? [] : [[role, level] as const]
        })
      )
    ])
  )
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
 * private team they have played for. Membership at any level reaches the
 * player pages of the teams below it: a member of a season or a league sees
 * the players of its teams as a member of the team does, as does a guardian
 * of a player on it. A season a team only competes in reaches none of its
 * players.
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
 * and whoever manages the roster of a team the person plays for: an
 * administrator, coach, assistant or scorekeeper of it, set on the team or
 * carried down from its season or league, and its owner or manager. A
 * scorekeeper may be the only person keeping the roster, so keeps this
 * (`canManageRoster`). A songkeeper or videographer holds a role on the team
 * but does not read its players' whole names.
 *
 * The whole name is read through `GET /players/:userId/name`, which this
 * guards, and a roster read with `includeFullNames` (`canManageRoster`).
 * Everything else — the ordinary roster, the player page, the box score —
 * carries `Jordan P` alone.
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
  // Preserve scorekeepers' full-name access: they may maintain the roster alone.
  const staffOf = new Set(
    (['admin', 'coach', 'assistant', 'scorekeeper'] as const).flatMap(role => [
      ...scopes[role].teamIds
    ])
  )
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
