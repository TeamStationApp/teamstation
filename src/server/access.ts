import {
  type AliasedSelectQueryBuilder,
  type Expression,
  type ExpressionBuilder,
  type Kysely,
  sql,
  type SqlBool
} from 'kysely'

import { IMPLIED_ROLES, type Role, ROLES } from '../common/roles'
import { onePeople, type OnePerson, onePerson } from './admin/people'
import { anyOf } from './db/anyOf'
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
  guardedIds?: ReadonlySet<string>
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
  userId: string
): Promise<OnePerson[]> {
  const actor = await onePerson(db, userId)
  const guarded = await guardedPeopleOfEach(db, new Map([[userId, actor]]))
  return guarded.get(userId)!
}

/**
 * `guardedPeople` of each of these people at once, by the key each came under:
 * one read of the links for all of their rows, one of the merges of everybody
 * linked.
 */
async function guardedPeopleOfEach(
  db: Kysely<Database>,
  actors: ReadonlyMap<string, OnePerson>
): Promise<Map<string, OnePerson[]>> {
  const rows = new Set([...actors.values()].flatMap(actor => actor.userIds))
  const links = await db
    .selectFrom('user_links')
    .select(['user_id', 'related_user_id'])
    .where('user_id', '=', anyOf([...rows]))
    .where('kind', 'in', ['guardian', 'family'])
    .execute()
  const related = new Map<string, string[]>()
  for (const link of links)
    related.set(link.user_id, [
      ...(related.get(link.user_id) ?? []),
      link.related_user_id
    ])
  const linked = await onePeople(
    db,
    links.map(link => link.related_user_id)
  )
  const guarded = new Map<string, OnePerson[]>()
  for (const [key, actor] of actors) {
    const own = new Set(actor.userIds)
    const people = new Map<string, OnePerson>()
    for (const row of actor.userIds)
      for (const relatedId of related.get(row) ?? []) {
        const child = linked.get(relatedId)!
        // Somebody closed into the asker is the asker, not their child.
        if (child.userIds.some(id => own.has(id))) continue
        people.set(child.userId, child)
      }
    guarded.set(
      key,
      [...people.values()].sort((a, b) => a.userId.localeCompare(b.userId))
    )
  }
  return guarded
}

/**
 * Every row of everybody this person is a guardian of, as a guardian
 * request's terms may name them, in no particular order.
 */
export async function guardedRows(
  db: Kysely<Database>,
  userId: string
): Promise<string[]> {
  return (await guardedPeople(db, userId)).flatMap(child => child.userIds)
}

/**
 * The players this person is a guardian of, by the row each signs in as:
 * every person a `guardian` or `family` link relates to any of the asker's
 * rows, in user id order.
 */
export async function guardedPlayers(
  db: Kysely<Database>,
  userId: string
): Promise<string[]> {
  return (await guardedPeople(db, userId)).map(child => child.userId)
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
  playerUserIds: readonly string[],
  options: { signsIn?: boolean } = {}
): Promise<string[]> {
  return [...(await guardiansOfEach(db, playerUserIds, options)).keys()]
}

/**
 * `guardiansOf`, with the players each one guards: guardian to the players,
 * each by the row they sign in as, in the order they were asked for. The
 * guardians are in user id order.
 */
export async function guardiansOfEach(
  db: Kysely<Database>,
  playerUserIds: readonly string[],
  { signsIn = false }: { signsIn?: boolean } = {}
): Promise<Map<string, string[]>> {
  const players = [...(await onePeople(db, playerUserIds)).values()]
  if (players.length === 0) return new Map()
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
  if (links.length === 0) return new Map()
  const parents = await onePeople(
    db,
    links.map(link => link.user_id)
  )
  const guardians = new Map<string, string[]>()
  for (const player of players)
    for (const link of links) {
      if (!player.userIds.includes(link.related_user_id)) continue
      const parent = parents.get(link.user_id)!
      if (parent.userIds.some(id => player.userIds.includes(id))) continue
      const guarded = guardians.get(parent.userId) ?? []
      if (!guarded.includes(player.userId)) guarded.push(player.userId)
      guardians.set(parent.userId, guarded)
    }
  if (guardians.size === 0) return new Map()
  const enabled = await db
    .selectFrom('users')
    .select('id')
    .where('id', 'in', [...guardians.keys()])
    .where('disabled_at', 'is', null)
    .$if(signsIn, query =>
      query.where('login_enabled', '=', true).where('merged_into', 'is', null)
    )
    .orderBy(sql`id collate "C"`)
    .execute()
  return new Map(enabled.map(row => [row.id, guardians.get(row.id)!]))
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
  playerUserIds: readonly string[]
): Promise<string[]> {
  return await guardiansOf(db, playerUserIds, { signsIn: true })
}

/**
 * `guardsPlayer` for a route that has the asker's `visibleScopes` and the
 * player as `onePerson` read them: from the guarded people already read.
 */
export async function guardsPerson(
  db: Kysely<Database>,
  scopes: VisibleScopes,
  actorUserId: string,
  player: OnePerson
): Promise<boolean> {
  const guarded =
    scopes.guardedIds ?? new Set(await guardedPlayers(db, actorUserId))
  return guarded.has(player.userId)
}

/** Whether `actorUserId` is a guardian of any row of `playerUserId`. */
export async function guardsPlayer(
  db: Kysely<Database>,
  actorUserId: string,
  playerUserId: string
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
  actor: { userId: string; isAdmin: boolean },
  playerUserId: string,
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
  userIds: readonly string[]
): Promise<string[]> {
  const byRow = await teamsPlayedOnNowByRow(db, userIds)
  return [...new Set([...byRow.values()].flat())]
}

/** `teamsPlayedOnNow` in one read, with the teams each row plays on. */
async function teamsPlayedOnNowByRow(
  db: Kysely<Database>,
  userIds: readonly string[]
): Promise<Map<string, string[]>> {
  const teams = new Map<string, string[]>()
  if (userIds.length === 0) return teams
  const plays = await db
    .selectFrom('memberships')
    .innerJoin('teams', 'teams.id', 'memberships.team_id')
    .select(['memberships.user_id', 'memberships.team_id'])
    .where('memberships.user_id', '=', anyOf(userIds))
    .where('memberships.is_player', '=', true)
    .where('teams.merged_into', 'is', null)
    .execute()
  for (const row of plays)
    teams.set(row.user_id, [...(teams.get(row.user_id) ?? []), row.team_id])
  return teams
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
  _isAdmin: boolean
): Promise<VisibleScopes> {
  const scopes = await visibleScopesForUsers(db, [userId])
  return scopes.get(userId)!
}

/**
 * `visibleScopes` of each of these people at once, with an answer for each,
 * in the same few reads however many there are: what one person takes, for
 * all of their rows together, with each person's sets then worked out here.
 * The one definition of who sees what; `visibleScopes` is this with one id.
 */
export async function visibleScopesForUsers(
  db: Kysely<Database>,
  userIds: readonly string[]
): Promise<Map<string, VisibleScopes>> {
  const answers = new Map<string, VisibleScopes>()
  for (const userId of userIds)
    answers.set(userId, {
      teamIds: new Set(),
      seasonIds: new Set(),
      isAdmin: false,
      guardedIds: new Set()
    })
  if (answers.size === 0) return answers
  const users = await db
    .selectFrom('users')
    .select(['id', 'is_admin', 'disabled_at', 'merged_into'])
    .where('id', '=', anyOf([...answers.keys()]))
    .execute()
  const open = users.filter(
    user => user.disabled_at == null && user.merged_into == null
  )
  if (open.length === 0) return answers
  const openIds = open.map(user => user.id)

  const memberships = await db
    .selectFrom('memberships')
    .select(['user_id', 'team_id'])
    .where('user_id', '=', anyOf(openIds))
    .execute()

  // A member of a season or a league is the same member a team has, of every
  // team below it, carried down as a role is: a league's seasons and teams,
  // each season's teams. Read as the teams there now rather than stored, so a
  // season created next spring is in the league the moment it exists. Read
  // across every row of the person, because a merge moves team memberships
  // onto the row kept but leaves these where they were written.
  const actors = await onePeople(db, openIds)
  const everyRow = [
    ...new Set([...actors.values()].flatMap(actor => actor.userIds))
  ]
  const seasonMemberships = await db
    .selectFrom('season_members')
    .select(['user_id', 'season_id'])
    .where('user_id', '=', anyOf(everyRow))
    .execute()
  const leagueMemberships = await db
    .selectFrom('league_members')
    .select(['user_id', 'league_id'])
    .where('user_id', '=', anyOf(everyRow))
    .execute()

  // Only actual memberships and true management roles supply private scopes.
  // Competition links never widen a member's access, even when a host opens
  // itself. The roles are carried down in the same pass as the membership,
  // as `roleScopes` carries them.
  const directs = await directRolesOfEach(db, openIds)
  const members = new Map<string, ScopeSet>()
  for (const userId of openIds) {
    const rows = new Set(actors.get(userId)!.userIds)
    members.set(userId, {
      leagueIds: new Set(
        leagueMemberships
          .filter(row => rows.has(row.user_id))
          .map(row => row.league_id)
      ),
      seasonIds: new Set(
        seasonMemberships
          .filter(row => rows.has(row.user_id))
          .map(row => row.season_id)
      ),
      teamIds: new Set()
    })
  }
  await inheritSets(db, [
    ...members.values(),
    ...[...directs.values()].flatMap(direct => ROLES.map(role => direct[role]))
  ])

  // A guardian is a member of every team their child plays on, for as long
  // as the child does: read from the child's memberships now, never written
  // down, so leaving a team takes it away again unless the guardian belongs
  // to it themselves.
  const guarded = await guardedPeopleOfEach(
    db,
    new Map(openIds.map(id => [id, actors.get(id)!]))
  )
  const childTeams = await teamsPlayedOnNowByRow(db, [
    ...new Set([...guarded.values()].flat().flatMap(child => child.userIds))
  ])

  for (const user of open) {
    const member = members.get(user.id)!
    const direct = directs.get(user.id)!
    const children = guarded.get(user.id)!
    const teamIds = new Set(member.teamIds)
    for (const row of memberships)
      if (row.user_id === user.id) teamIds.add(row.team_id)
    for (const child of children)
      for (const row of child.userIds)
        for (const teamId of childTeams.get(row) ?? []) teamIds.add(teamId)
    // Every role's sets, unioned. The implied roles are not added first: they
    // only copy their givers' sets, which this union already holds.
    const seasonIds = new Set(member.seasonIds)
    for (const role of ROLES) {
      for (const teamId of direct[role].teamIds) teamIds.add(teamId)
      for (const seasonId of direct[role].seasonIds) seasonIds.add(seasonId)
    }
    answers.set(user.id, {
      teamIds,
      seasonIds,
      isAdmin: user.is_admin,
      guardedIds: new Set(children.map(child => child.userId))
    })
  }
  return answers
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
  await inheritSets(db, Object.values<ScopeSet>(direct))
  return direct
}

/** Adds `value` to the list under `key`. */
function listUnder(
  lists: Map<string, string[]>,
  key: string,
  value: string
): void {
  const list = lists.get(key)
  if (list == null) lists.set(key, [value])
  else list.push(value)
}

/**
 * `inheritScopes` over any number of sets, however many people they belong to:
 * the links of the union of their ids are read once, then each set is filled
 * from them here.
 */
async function inheritSets(
  db: Kysely<Database>,
  sets: readonly ScopeSet[]
): Promise<void> {
  const leagueIds = new Set(sets.flatMap(set => [...set.leagueIds]))
  if (leagueIds.size > 0) {
    const seasons = await db
      .selectFrom('seasons')
      .select(['id', 'league_id'])
      .where('league_id', '=', anyOf([...leagueIds]))
      .execute()
    const leagueTeams = await db
      .selectFrom('teams')
      .select(['id', 'league_id'])
      .where('league_id', '=', anyOf([...leagueIds]))
      .execute()
    const seasonsOf = new Map<string, string[]>()
    const teamsOf = new Map<string, string[]>()
    for (const row of seasons) listUnder(seasonsOf, row.league_id!, row.id)
    for (const row of leagueTeams) listUnder(teamsOf, row.league_id!, row.id)
    for (const set of sets)
      for (const leagueId of set.leagueIds) {
        for (const id of seasonsOf.get(leagueId) ?? []) set.seasonIds.add(id)
        for (const id of teamsOf.get(leagueId) ?? []) set.teamIds.add(id)
      }
  }
  const seasonIds = new Set(sets.flatMap(set => [...set.seasonIds]))
  if (seasonIds.size > 0) {
    const links = await db
      .selectFrom(permissionParents(db))
      .select(['season_id', 'team_id'])
      .where('season_id', '=', anyOf([...seasonIds]))
      .execute()
    const teamsOf = new Map<string, string[]>()
    for (const row of links) listUnder(teamsOf, row.season_id, row.team_id)
    for (const set of sets)
      for (const seasonId of set.seasonIds)
        for (const id of teamsOf.get(seasonId) ?? []) set.teamIds.add(id)
  }
}

/**
 * The teams a season or league reaches, as membership and roles flow down to
 * them: a season's teams through its parent links, a league's seasons' teams
 * and the teams in the league. A team reaches itself.
 */
export async function teamsUnder(
  db: Kysely<Database>,
  ref: { kind: 'league' | 'season' | 'team'; id: string }
): Promise<Set<string>> {
  if (ref.kind === 'team') return new Set([ref.id])
  const { under } = await inheritScopes(db, {
    under: {
      leagueIds: new Set(ref.kind === 'league' ? [ref.id] : []),
      seasonIds: new Set(ref.kind === 'season' ? [ref.id] : []),
      teamIds: new Set<string>()
    }
  })
  return under.teamIds
}

/**
 * Every role this person holds, and where.
 *
 * The `scope_roles` rows, plus a team's owner or manager as that team's
 * administrator, so there is one place to look rather than two. Then each
 * role is carried downwards, and each role's sets are added to those of the
 * roles it brings with it (`IMPLIED_ROLES`): the administrator's to every
 * flag's, and the scorekeeper's to the songkeeper's.
 *
 * These are the roles a person may **use**. The roles they were **given**,
 * which is what a list of staff shows, are `givenRolesOnTeam`.
 */
export async function roleScopes(
  db: Kysely<Database>,
  userId: string,
  _isAdmin: boolean
): Promise<RoleScopes> {
  const scopes = await roleScopesForUsers(db, [userId])
  return scopes.get(userId)!
}

/**
 * `roleScopes` of each of these rows at once, in one set of reads however many
 * there are, each answer as though it had been asked for alone. Somebody who
 * has no open row holds nothing.
 */
export async function roleScopesForUsers(
  db: Kysely<Database>,
  userIds: readonly string[]
): Promise<Map<string, RoleScopes>> {
  const answers = new Map<string, RoleScopes>()
  for (const userId of userIds)
    answers.set(userId, { ...noRoles(), isAdmin: false })
  if (answers.size === 0) return answers

  const users = await db
    .selectFrom('users')
    .select(['id', 'is_admin', 'disabled_at', 'merged_into'])
    .where('id', '=', anyOf([...answers.keys()]))
    .execute()
  const open = users.filter(
    user => user.disabled_at == null && user.merged_into == null
  )
  if (open.length === 0) return answers

  const directs = await directRolesOfEach(
    db,
    open.map(user => user.id)
  )
  await inheritSets(
    db,
    [...directs.values()].flatMap(roles => Object.values<ScopeSet>(roles))
  )
  for (const user of open) {
    const inherited = directs.get(user.id)!
    addImpliedRoles(inherited)
    answers.set(user.id, { ...inherited, isAdmin: user.is_admin })
  }
  return answers
}

function noRoles(): Record<Role, ScopeSet> {
  return Object.fromEntries(ROLES.map(role => [role, emptyScopes()])) as Record<
    Role,
    ScopeSet
  >
}

/**
 * Where each of these rows was given each role, before it is carried down: the
 * `scope_roles` rows, and a team's owner or manager as its administrator. Two
 * reads however many rows there are.
 */
async function directRolesOfEach(
  db: Kysely<Database>,
  userIds: readonly string[]
): Promise<Map<string, Record<Role, ScopeSet>>> {
  const directs = new Map(userIds.map(id => [id, noRoles()]))
  const rows = await db
    .selectFrom('scope_roles')
    .select(['user_id', 'scope_type', 'scope_id', 'role'])
    .where('user_id', '=', anyOf(userIds))
    .execute()
  for (const row of rows) {
    const set = directs.get(row.user_id)![row.role]
    if (row.scope_type === 'league') set.leagueIds.add(row.scope_id)
    if (row.scope_type === 'season') set.seasonIds.add(row.scope_id)
    if (row.scope_type === 'team') set.teamIds.add(row.scope_id)
  }

  const owned = await db
    .selectFrom('memberships')
    .select(['user_id', 'team_id'])
    .where('user_id', '=', anyOf(userIds))
    .where('role', 'in', ['owner', 'manager'])
    .execute()
  for (const row of owned)
    directs.get(row.user_id)!.admin.teamIds.add(row.team_id)
  return directs
}

/**
 * Adds each role's sets, once carried down, to those of the roles it brings
 * with it (`IMPLIED_ROLES`), in place.
 */
function addImpliedRoles(inherited: Record<Role, ScopeSet>): void {
  for (const [flag, giver] of ROLES.flatMap(giver =>
    IMPLIED_ROLES[giver].map(flag => [flag, giver] as const)
  )) {
    for (const key of ['leagueIds', 'seasonIds', 'teamIds'] as const) {
      for (const id of inherited[giver][key]) inherited[flag][key].add(id)
    }
  }
}

/**
 * Where this user may change things, including what they inherit downwards.
 *
 * Administrator rows only: a flag grants what it names and never what an
 * administrator may do, so no flag ever widens this.
 */
export async function adminScopes(
  db: Kysely<Database>,
  userId: string,
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

/**
 * The team's head coach: the coach flag itself, which every administrator of
 * the team holds. An assistant is not one, so he may not save the team's
 * lineup in a game.
 */
export function isHeadCoach(scopes: RoleScopes, teamId: string): boolean {
  return hasRole(scopes, 'coach', teamId)
}

/**
 * The teams of a game whose lineups these scopes may save: both, for a
 * scorekeeper of either team; otherwise each team they are head coach of.
 * Whoever may save a side's lineup is answered its players' first and last
 * names: he may correct a game-only player's, and his tools export the
 * lineup and match spoken names by them.
 */
export function lineupTeams(
  scopes: RoleScopes,
  game: { home_team_id: string; away_team_id: string }
): string[] {
  const teams = [game.away_team_id, game.home_team_id]
  if (teams.some(teamId => canScore(scopes, teamId))) return teams
  return teams.filter(teamId => isHeadCoach(scopes, teamId))
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
): Promise<Map<string, Role[]>> {
  const levels = await givenRoleLevelsOnTeam(db, teamId)
  return new Map(
    [...levels].map(([userId, held]) => [userId, [...held.keys()]])
  )
}

/**
 * `givenRolesOnTeam` for many teams in a fixed handful of queries, for a
 * list that names each team's staff: the roles given on each team (with its
 * owner's or manager's `admin`), its seasons and their leagues.
 */
export async function givenRolesOnTeams(
  db: Kysely<Database>,
  teamIds: string[]
): Promise<Map<string, Map<string, Role[]>>> {
  const result = new Map<string, Map<string, Role[]>>(
    teamIds.map(id => [id, new Map()])
  )
  if (teamIds.length === 0) return result
  const seasons = await db
    .selectFrom(permissionParents(db))
    .innerJoin('seasons', 'seasons.id', 'permission_parents.season_id')
    .select([
      'permission_parents.team_id as teamId',
      'seasons.id as seasonId',
      'seasons.league_id as leagueId'
    ])
    .where('permission_parents.team_id', 'in', teamIds)
    .execute()
  const teams = await db
    .selectFrom('teams')
    .select(['id', 'league_id'])
    .where('id', 'in', teamIds)
    .execute()
  const levels = new Map(
    teamIds.map(id => [
      id,
      { seasonIds: new Set<string>(), leagueIds: new Set<string>() }
    ])
  )
  for (const team of teams)
    if (team.league_id != null)
      levels.get(team.id)!.leagueIds.add(team.league_id)
  for (const row of seasons) {
    const level = levels.get(row.teamId)!
    level.seasonIds.add(row.seasonId)
    if (row.leagueId != null) level.leagueIds.add(row.leagueId)
  }
  const seasonIds = [...new Set(seasons.map(row => row.seasonId))]
  const leagueIds = [
    ...new Set([...levels.values()].flatMap(level => [...level.leagueIds]))
  ]
  const rows = await db
    .selectFrom('scope_roles')
    .innerJoin('users', 'users.id', 'scope_roles.user_id')
    .select([
      'scope_roles.user_id',
      'scope_roles.role',
      'scope_roles.scope_type',
      'scope_roles.scope_id'
    ])
    .where('users.disabled_at', 'is', null)
    .where('users.merged_into', 'is', null)
    .where(eb =>
      eb.or([
        eb.and([
          eb('scope_roles.scope_type', '=', 'team'),
          eb('scope_roles.scope_id', 'in', teamIds)
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
    .select(['memberships.user_id', 'memberships.team_id'])
    .where('memberships.team_id', 'in', teamIds)
    .where('memberships.role', 'in', ['owner', 'manager'])
    .where('users.disabled_at', 'is', null)
    .where('users.merged_into', 'is', null)
    .execute()
  for (const teamId of teamIds) {
    const level = levels.get(teamId)!
    const held = new Map<string, Set<Role>>()
    const give = (userId: string, role: Role): void => {
      held.set(userId, (held.get(userId) ?? new Set<Role>()).add(role))
    }
    for (const row of rows)
      if (
        (row.scope_type === 'team' && row.scope_id === teamId) ||
        (row.scope_type === 'season' && level.seasonIds.has(row.scope_id)) ||
        (row.scope_type === 'league' && level.leagueIds.has(row.scope_id))
      )
        give(row.user_id, row.role)
    for (const row of owners)
      if (row.team_id === teamId) give(row.user_id, 'admin')
    result.set(
      teamId,
      new Map(
        [...held].map(([userId, roles]) => [
          userId,
          ROLES.filter(role => roles.has(role))
        ])
      )
    )
  }
  return result
}

/** Where a role was given, from the team up. */
export type RoleLevel = 'team' | 'season' | 'league'

/**
 * The seasons a team's roles and members come down from, and their leagues
 * with the team's own: the other side of what `inheritScopes` carries down.
 */
export async function levelsAboveTeam(
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
 * The members of these seasons and leagues: for a team, those above it
 * (`levelsAboveTeam`), everybody `visibleScopes` makes a member of it from
 * their side. Keyed by the row each signs in as, with the highest level that
 * holds them: a member of both the season and its league is a league member.
 * A membership written under a row since closed into another is the open
 * row's; a disabled account is left out.
 */
export async function membersOfLevels(
  db: Kysely<Database>,
  { seasonIds, leagueIds }: { seasonIds: string[]; leagueIds: string[] }
): Promise<Map<string, Exclude<RoleLevel, 'team'>>> {
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
  const people = await onePeople(
    db,
    rows.map(row => row.userId)
  )
  const survivors = [...new Set([...people.values()].map(p => p.userId))]
  const open =
    survivors.length === 0
      ? new Set<string>()
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
  const members = new Map<string, Exclude<RoleLevel, 'team'>>()
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
): Promise<Map<string, Map<Role, RoleLevel>>> {
  return await givenRoleLevelsAt(db, {
    teamId,
    ...(await levelsAboveTeam(db, teamId))
  })
}

/**
 * `givenRoleLevelsOnTeam` for any set of levels: the roles given on this
 * team (with its owner's or manager's `admin`), these seasons and these
 * leagues, each at the highest level that gives it. A season's people list
 * asks for the season and its league, with no team.
 */
export async function givenRoleLevelsAt(
  db: Kysely<Database>,
  {
    teamId,
    seasonIds,
    leagueIds
  }: { teamId?: string; seasonIds: string[]; leagueIds: string[] }
): Promise<Map<string, Map<Role, RoleLevel>>> {
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
        ...(teamId == null
          ? []
          : [
              eb.and([
                eb('scope_roles.scope_type', '=', 'team'),
                eb('scope_roles.scope_id', '=', teamId)
              ])
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
  const owners =
    teamId == null
      ? []
      : await db
          .selectFrom('memberships')
          .innerJoin('users', 'users.id', 'memberships.user_id')
          .select('memberships.user_id')
          .where('memberships.team_id', '=', teamId)
          .where('memberships.role', 'in', ['owner', 'manager'])
          .where('users.disabled_at', 'is', null)
          .where('users.merged_into', 'is', null)
          .execute()

  const held = new Map<string, Map<Role, RoleLevel>>()
  const give = (userId: string, role: Role, level: RoleLevel): void => {
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

/**
 * Whether this caller reads a team in the non-member view: signed in, unable
 * to see the team as a member does, and the team still there under its own
 * name (not merged into another). Following it makes no difference. A member
 * never is; signed out, nobody is, and keeps the public page.
 */
export async function nonMemberTeam(
  db: Kysely<Database>,
  actor: { userId: string } | null | undefined,
  scopes: VisibleScopes,
  teamId: string
): Promise<boolean> {
  if (actor == null || canSeeTeam(scopes, teamId)) return false
  const team = await db
    .selectFrom('teams')
    .select('id')
    .where('id', '=', teamId)
    .where('merged_into', 'is', null)
    .executeTakeFirst()
  return team != null
}

/** A team a person played for, in the season they played for it. */
export interface PlayedFor {
  teamId: string
  seasonId: string | null
  /** A team they played for only as a pool player: it opens nobody's page. */
  viaPool?: boolean
}

/**
 * Which of these people this viewer could open the page of, as `GET
 * /players/:id` answers it, for a whole box score or season table at once:
 * themselves, anybody they guard, and anybody on a team they can see, by
 * membership or by a stat line that is neither a pool game's nor a
 * withdrawn game's.
 */
export async function openablePeople(
  db: Kysely<Database>,
  scopes: VisibleScopes,
  viewerUserId: string,
  userIds: readonly string[]
): Promise<Set<string>> {
  const ids = [...new Set(userIds)]
  if (scopes.isAdmin) return new Set(ids)
  // Themselves, and anybody they guard: their page is theirs to open
  // wherever the line is from.
  const guarded =
    scopes.guardedIds ?? new Set(await guardedPlayers(db, viewerUserId))
  const open = new Set(ids.filter(id => id === viewerUserId || guarded.has(id)))
  const teams = [...scopes.teamIds]
  if (teams.length === 0 || ids.length === 0) return open
  // As `teamsOf` counts the teams a person played for: a player's
  // membership, on a team not merged away.
  const members = await db
    .selectFrom('memberships')
    .innerJoin('teams', 'teams.id', 'memberships.team_id')
    .select('memberships.user_id')
    .distinct()
    .where('memberships.user_id', 'in', ids)
    .where('memberships.team_id', 'in', teams)
    .where('memberships.is_player', '=', true)
    .where('teams.merged_into', 'is', null)
    .execute()
  for (const row of members) open.add(row.user_id)
  const played = await db
    .selectFrom('game_player_stats')
    .innerJoin('gumbo_ids', 'gumbo_ids.gumbo_id', 'game_player_stats.gumbo_id')
    .select('gumbo_ids.user_id')
    .distinct()
    .where('gumbo_ids.user_id', 'in', ids)
    .where('game_player_stats.team_id', 'in', teams)
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('game_guest_details')
            .select('game_guest_details.game_id')
            .whereRef(
              'game_guest_details.game_id',
              '=',
              'game_player_stats.game_id'
            )
            .whereRef('game_guest_details.user_id', '=', 'gumbo_ids.user_id')
            .where('game_guest_details.pool', '=', true)
        )
      )
    )
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('game_withdrawn_players')
            .select('game_withdrawn_players.game_id')
            .whereRef(
              'game_withdrawn_players.game_id',
              '=',
              'game_player_stats.game_id'
            )
            .whereRef(
              'game_withdrawn_players.user_id',
              '=',
              'gumbo_ids.user_id'
            )
        )
      )
    )
    .execute()
  for (const row of played) open.add(row.user_id)
  return open
}

/** Whether a team a person played for is one this viewer can see. */
export function canSeePlayedFor(
  scopes: VisibleScopes,
  team: PlayedFor
): boolean {
  return (
    scopes.isAdmin || (team.viaPool !== true && scopes.teamIds.has(team.teamId))
  )
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

/**
 * Whether somebody reads a level's people list with its photos: a team's
 * members (`canSeeTeam`), a season's (and so its league's) members and role
 * holders, a league's members and role holders, and a site administrator.
 */
export async function seesPeopleOf(
  db: Kysely<Database>,
  actor: { userId: string; isAdmin: boolean },
  ref: { kind: 'league' | 'season' | 'team'; id: string }
): Promise<boolean> {
  const visible = await visibleScopes(db, actor.userId, actor.isAdmin)
  if (visible.isAdmin) return true
  if (ref.kind === 'team') return visible.teamIds.has(ref.id)
  if (ref.kind === 'season') return visible.seasonIds.has(ref.id)
  const roles = await roleScopes(db, actor.userId, actor.isAdmin)
  if (ROLES.some(role => roles[role].leagueIds.has(ref.id))) return true
  const member = await db
    .selectFrom('league_members')
    .select('id')
    .where('league_id', '=', ref.id)
    .where('user_id', 'in', (await onePerson(db, actor.userId)).userIds)
    .executeTakeFirst()
  return member != null
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
  actorUserId: string,
  playerUserId: string,
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

/** Legacy team-follow listing, separate from private team visibility. */
export async function canReadFollowedTeam(
  db: Kysely<Database>,
  userId: string,
  teamId: string
): Promise<boolean> {
  const row = await db
    .selectFrom('team_follows')
    .select('team_id')
    .where('user_id', '=', userId)
    .where('team_id', '=', teamId)
    .executeTakeFirst()
  return row != null
}
