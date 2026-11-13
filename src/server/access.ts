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
import { openAddsOf, openAddTeams, openArrivalsOf } from './openAdds'

export {
  heldByOpenAdd,
  openAdds,
  openAddsOf,
  openAddTeams,
  openArrivalsOf
} from './openAdds'

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
  /** Membership and guardian teams before management roles broaden visibility. */
  memberTeamIds?: ReadonlySet<string>
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
    listUnder(related, link.user_id, link.related_user_id)
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
      '=',
      anyOf(players.flatMap(player => player.userIds))
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
    .where('id', '=', anyOf([...guardians.keys()]))
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
  // A team holding them only by an open add manages what is the team's, by
  // the route with its id: not what is the person's.
  const plays = await settledTeams(db, player.userIds)
  return plays.some(team => canManageRoster(scopes, team))
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
  for (const row of plays) listUnder(teams, row.user_id, row.team_id)
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
  const leaguesOfRow = new Map<string, string[]>()
  for (const row of leagueMemberships)
    listUnder(leaguesOfRow, row.user_id, row.league_id)
  const seasonsOfRow = new Map<string, string[]>()
  for (const row of seasonMemberships)
    listUnder(seasonsOfRow, row.user_id, row.season_id)
  const members = new Map<string, ScopeSet>()
  for (const userId of openIds) {
    const rows = actors.get(userId)!.userIds
    members.set(userId, {
      leagueIds: new Set(rows.flatMap(row => leaguesOfRow.get(row) ?? [])),
      seasonIds: new Set(rows.flatMap(row => seasonsOfRow.get(row) ?? [])),
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

  const teamsOfUser = new Map<string, string[]>()
  for (const row of memberships)
    listUnder(teamsOfUser, row.user_id, row.team_id)

  for (const user of open) {
    const member = members.get(user.id)!
    const direct = directs.get(user.id)!
    const children = guarded.get(user.id)!
    const teamIds = new Set(member.teamIds)
    for (const teamId of teamsOfUser.get(user.id) ?? []) teamIds.add(teamId)
    for (const child of children)
      for (const row of child.userIds)
        for (const teamId of childTeams.get(row) ?? []) teamIds.add(teamId)
    const memberTeamIds = new Set(teamIds)
    // Every role's sets, unioned. The implied roles are not added first: they
    // only copy their givers' sets, which this union already holds.
    const seasonIds = new Set(member.seasonIds)
    for (const role of ROLES) {
      for (const teamId of direct[role].teamIds) teamIds.add(teamId)
      for (const seasonId of direct[role].seasonIds) seasonIds.add(seasonId)
    }
    answers.set(user.id, {
      teamIds,
      memberTeamIds,
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
  const asked = [...new Set(userIds)]
  if (scopes.isAdmin) return new Set(asked)
  if (asked.length === 0) return new Set()
  // A person's lines and memberships may sit on rows merged into them, as
  // `teamsOf` counts them: each row answers for the person asked about.
  const rows = await sql<{ id: string; person: string }>`
    with recursive family as (
      select id, id as person from users where id in (${sql.join(asked)})
      union
      select u.id, f.person from users u
        join family f on u.merged_into = f.id
    )
    select id, person from family`.execute(db)
  const personOf = new Map(rows.rows.map(row => [row.id, row.person]))
  const ids = [...personOf.keys()]
  // Themselves, and anybody they guard: their page is theirs to open
  // wherever the line is from.
  const guarded =
    scopes.guardedIds ?? new Set(await guardedPlayers(db, viewerUserId))
  const open = new Set(
    ids
      .filter(id => id === viewerUserId || guarded.has(id))
      .map(id => personOf.get(id)!)
  )
  const teams = [...scopes.teamIds]
  if (teams.length === 0) return open
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
  for (const row of members) open.add(personOf.get(row.user_id)!)
  const played = await db
    .selectFrom('game_player_stats')
    .innerJoin('gumbo_ids', 'gumbo_ids.gumbo_id', 'game_player_stats.gumbo_id')
    .select(['gumbo_ids.user_id', 'game_player_stats.game_id'])
    .distinct()
    .where('gumbo_ids.user_id', 'in', ids)
    .where('game_player_stats.team_id', 'in', teams)
    .execute()
  // A game they played as a pool player, or were withdrawn from, opens
  // nothing, on whichever of their rows it is held.
  const pool = await db
    .selectFrom('game_guest_details')
    .select(['user_id', 'game_id'])
    .where('user_id', 'in', ids)
    .where('pool', '=', true)
    .execute()
  const withdrawn = await db
    .selectFrom('game_withdrawn_players')
    .select(['user_id', 'game_id'])
    .where('user_id', 'in', ids)
    .execute()
  const key = (row: { user_id: string; game_id: string }): string =>
    `${row.game_id} ${personOf.get(row.user_id)}`
  const closed = new Set([...pool, ...withdrawn].map(key))
  for (const row of played)
    if (!closed.has(key(row))) open.add(personOf.get(row.user_id)!)
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
  return (
    await mayEditNames(
      db,
      actorUserId,
      [playerUserId],
      about,
      known.player == null ? new Map() : new Map([[playerUserId, known.player]])
    )
  ).has(playerUserId)
}

/** The same name authority for a batch, with shared identity and role reads. */
export async function mayEditNames(
  db: Kysely<Database>,
  actorUserId: string,
  playerUserIds: readonly string[],
  about: { isAdmin: boolean },
  known: ReadonlyMap<string, OnePerson> = new Map()
): Promise<Set<string>> {
  return (await nameAuthority(db, actorUserId, playerUserIds, about, known))
    .allowed
}

/**
 * `mayEditNames`, with the reads it made on the way for a caller that goes on
 * to ask more of the same people: each person's rows it gathered (`people`),
 * and the asker's roles, when it read them (`roles`).
 */
async function nameAuthority(
  db: Kysely<Database>,
  actorUserId: string,
  playerUserIds: readonly string[],
  about: { isAdmin: boolean },
  known: ReadonlyMap<string, OnePerson>
): Promise<{
  allowed: Set<string>
  people: ReadonlyMap<string, OnePerson>
  roles?: RoleScopes
}> {
  const allowed = new Set<string>()
  if (about.isAdmin)
    return { allowed: new Set(playerUserIds), people: new Map() }
  const asked = [...new Set(playerUserIds)]
  if (asked.includes(actorUserId)) allowed.add(actorUserId)
  const others = asked.filter(id => id !== actorUserId)
  if (others.length === 0) return { allowed, people: new Map() }
  const gathered = await onePeople(db, [
    actorUserId,
    ...others.filter(id => known.get(id)?.userIds.includes(id) !== true)
  ])
  const actor = gathered.get(actorUserId)!
  const players = new Map(
    others.map(id => [
      id,
      known.get(id)?.userIds.includes(id) === true
        ? known.get(id)!
        : gathered.get(id)!
    ])
  )
  const links = await db
    .selectFrom('user_links')
    .select('related_user_id')
    .where('user_id', '=', anyOf(actor.userIds))
    .where('kind', 'in', ['guardian', 'family'])
    .execute()
  const children = new Set(links.map(row => row.related_user_id))
  for (const [id, player] of players)
    if (
      player.userIds.includes(actorUserId) ||
      player.userIds.some(row => children.has(row))
    )
      allowed.add(id)
  const remaining = [...players].filter(([id]) => !allowed.has(id))
  if (remaining.length === 0) return { allowed, people: players }
  const scopes = await roleScopes(db, actorUserId, false)
  const staffOf = [
    ...new Set(
      (['admin', 'coach', 'assistant', 'scorekeeper'] as const).flatMap(
        role => [...scopes[role].teamIds]
      )
    )
  ]
  if (staffOf.length === 0) return { allowed, people: players, roles: scopes }
  const rows = remaining.flatMap(([, player]) => player.userIds)
  const [plays, held] = await Promise.all([
    db
      .selectFrom('memberships')
      .select(['user_id', 'team_id'])
      .where('user_id', '=', anyOf(rows))
      .where('is_player', '=', true)
      .where('team_id', '=', anyOf(staffOf))
      .execute(),
    openAddsOf(db, staffOf)
  ])
  const teamsByRow = new Map<string, string[]>()
  for (const play of plays) listUnder(teamsByRow, play.user_id, play.team_id)
  for (const [id, player] of remaining)
    if (
      player.userIds.some(row =>
        (teamsByRow.get(row) ?? []).some(
          team =>
            !player.userIds.some(other => held.get(team)?.has(other) === true)
        )
      )
    )
      allowed.add(id)
  return { allowed, people: players, roles: scopes }
}

/**
 * Whether this reader may **see** this person's full name: `mayViewFullNames`
 * of one.
 */
export async function mayViewFullName(
  db: Kysely<Database>,
  readerUserId: string,
  userId: string,
  about: { isAdmin: boolean },
  known?: ReadonlyMap<string, OnePerson>
): Promise<boolean> {
  return (await mayViewFullNames(db, readerUserId, [userId], about, known)).has(
    userId
  )
}

/**
 * Whether this reader may **see** each person's full name: whoever may change
 * it (`mayEditNames`), and whoever manages the people (`canManagePeople`) of
 * a level whose people list shows the person. Seeing never grants changing:
 * everything that changes a name, or reads its halves to change them, asks
 * `mayEditName(s)`.
 *
 * The level rule is the person profile's: a level's administrators, coaches
 * and assistants (`roleScopes`, carried down from league to season to team)
 * read in full everybody its people list holds (`onPeopleList`):
 *
 * - its members (a team's memberships, player or not; `season_members`;
 *   `league_members`), its role holders (`scope_roles`) and its followers;
 * - the players of its teams and their guardians and family (a `guardian` or
 *   `family` link), through the teams the players play on now;
 * - on a team's list, the members and role holders of the seasons and league
 *   above it, and on a season's, its league's;
 * - for a league administrator, the league's umpires, whose profile they open.
 *
 * A team that holds a person, or the player they guard, only by an open add
 * does not put them on its list. A disabled person stays on a list only as a
 * team's member or a player. An external team's people are its custodian's
 * administrators', as `canAdminister` says. A reader whose own account is
 * disabled, closed into another or unable to sign in gets the `mayEditNames`
 * answer alone.
 *
 * A fixed number of queries whatever the length of the list; `known` is
 * passed through to `mayEditNames`, and the rows and roles it read on the way
 * are reused.
 */
export async function mayViewFullNames(
  db: Kysely<Database>,
  readerUserId: string,
  userIds: readonly string[],
  about: { isAdmin: boolean },
  known: ReadonlyMap<string, OnePerson> = new Map()
): Promise<Set<string>> {
  const edit = await nameAuthority(db, readerUserId, userIds, about, known)
  const { allowed } = edit
  const asked = [...new Set(userIds)].filter(id => !allowed.has(id))
  if (asked.length === 0) return allowed

  const standing = await db
    .selectFrom('users')
    .select(['is_admin', 'disabled_at', 'merged_into', 'login_enabled'])
    .where('id', '=', readerUserId)
    .executeTakeFirst()
  if (
    standing == null ||
    standing.disabled_at != null ||
    standing.merged_into != null ||
    !standing.login_enabled
  )
    return allowed
  const roles = edit.roles ?? (await roleScopes(db, readerUserId, false))
  const manages = emptyScopes()
  for (const role of ['admin', 'coach', 'assistant'] as const)
    for (const key of ['leagueIds', 'seasonIds', 'teamIds'] as const)
      for (const id of roles[role][key]) manages[key].add(id)
  if (
    manages.leagueIds.size === 0 &&
    manages.seasonIds.size === 0 &&
    manages.teamIds.size === 0
  )
    return allowed

  const levels = await peopleListLevels(
    db,
    asked,
    new Map([...edit.people, ...known])
  )
  const external = await externalCustodians(db, [
    ...new Set([...levels.values()].flatMap(level => [...level.teamIds]))
  ])
  const administers = (custodian: Custodian): boolean =>
    custodian.type === 'league'
      ? roles.admin.leagueIds.has(custodian.id)
      : custodian.type === 'season'
        ? roles.admin.seasonIds.has(custodian.id)
        : roles.admin.teamIds.has(custodian.id)
  for (const [id, level] of levels) {
    const managed =
      [...level.leagueIds].some(league => manages.leagueIds.has(league)) ||
      [...level.seasonIds].some(season => manages.seasonIds.has(season)) ||
      [...level.teamIds].some(team => {
        if (manages.teamIds.has(team)) return true
        const custodian = external.get(team)
        return custodian != null && administers(custodian)
      }) ||
      [...level.umpireLeagueIds].some(league =>
        roles.admin.leagueIds.has(league)
      )
    if (managed) allowed.add(id)
  }
  return allowed
}

/**
 * Which of these readers may **see** this one person's full name: each
 * reader's own `mayViewFullNames` of that person, asked the other way round
 * so that many readers take a fixed number of queries, not a set each. The
 * person's rows, the teams they play on, their open adds and the levels whose
 * people lists hold them are read once; the readers' rows, guardian and family
 * links, standing and roles are read for all of them together.
 */
export async function mayViewFullNameOf(
  db: Kysely<Database>,
  userId: string,
  readers: ReadonlyArray<{ userId: string; isAdmin: boolean }>
): Promise<Set<string>> {
  const allowed = new Set<string>()
  // `nameAuthority`: a site admin, and the person themself.
  for (const reader of readers)
    if (reader.isAdmin || reader.userId === userId) allowed.add(reader.userId)
  let rest = [
    ...new Set(
      readers.map(reader => reader.userId).filter(id => !allowed.has(id))
    )
  ]
  if (rest.length === 0) return allowed
  const gathered = await onePeople(db, [userId, ...rest])
  const person = gathered.get(userId)!
  const rowsOf = (id: string): string[] => gathered.get(id)?.userIds ?? [id]
  // Another of their own rows, or a guardian or family of one of them.
  for (const id of rest) if (person.userIds.includes(id)) allowed.add(id)
  rest = rest.filter(id => !allowed.has(id))
  if (rest.length === 0) return allowed
  const linked = new Set(
    (
      await db
        .selectFrom('user_links')
        .select('user_id')
        .where('related_user_id', '=', anyOf(person.userIds))
        .where('kind', 'in', ['guardian', 'family'])
        .where('user_id', '=', anyOf(rest.flatMap(rowsOf)))
        .execute()
    ).map(row => row.user_id)
  )
  for (const id of rest)
    if (rowsOf(id).some(row => linked.has(row))) allowed.add(id)
  rest = rest.filter(id => !allowed.has(id))
  if (rest.length === 0) return allowed

  const roles = await roleScopesForUsers(db, rest)
  // Staff of a team the person plays on, unless an open add alone holds them
  // there.
  const plays = await db
    .selectFrom('memberships')
    .select('team_id')
    .where('user_id', '=', anyOf(person.userIds))
    .where('is_player', '=', true)
    .execute()
  const playTeams = [...new Set(plays.map(play => play.team_id))]
  const held = await openAddsOf(db, playTeams)
  const settled = new Set(
    playTeams.filter(
      team => !person.userIds.some(row => held.get(team)?.has(row) === true)
    )
  )
  for (const id of rest)
    if (
      (['admin', 'coach', 'assistant', 'scorekeeper'] as const).some(role =>
        [...roles.get(id)![role].teamIds].some(team => settled.has(team))
      )
    )
      allowed.add(id)
  rest = rest.filter(id => !allowed.has(id))
  if (rest.length === 0) return allowed

  // `mayViewFullNames`: managers of a level whose people list holds them, if
  // their own account stands.
  const standing = new Set(
    (
      await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', anyOf(rest))
        .where('disabled_at', 'is', null)
        .where('merged_into', 'is', null)
        .where('login_enabled', '=', true)
        .execute()
    ).map(row => row.id)
  )
  const manages = new Map<string, ScopeSet>()
  for (const id of rest) {
    if (!standing.has(id)) continue
    const scopes = emptyScopes()
    for (const role of ['admin', 'coach', 'assistant'] as const)
      for (const key of ['leagueIds', 'seasonIds', 'teamIds'] as const)
        for (const level of roles.get(id)![role][key]) scopes[key].add(level)
    if (
      scopes.leagueIds.size > 0 ||
      scopes.seasonIds.size > 0 ||
      scopes.teamIds.size > 0
    )
      manages.set(id, scopes)
  }
  if (manages.size === 0) return allowed
  const level = (
    await peopleListLevels(db, [userId], new Map([[userId, person]]))
  ).get(userId)!
  const external = await externalCustodians(db, [...level.teamIds])
  for (const [id, scopes] of manages) {
    const admin = roles.get(id)!.admin
    const administers = (custodian: Custodian): boolean =>
      custodian.type === 'league'
        ? admin.leagueIds.has(custodian.id)
        : custodian.type === 'season'
          ? admin.seasonIds.has(custodian.id)
          : admin.teamIds.has(custodian.id)
    if (
      [...level.leagueIds].some(league => scopes.leagueIds.has(league)) ||
      [...level.seasonIds].some(season => scopes.seasonIds.has(season)) ||
      [...level.teamIds].some(team => {
        if (scopes.teamIds.has(team)) return true
        const custodian = external.get(team)
        return custodian != null && administers(custodian)
      }) ||
      [...level.umpireLeagueIds].some(league => admin.leagueIds.has(league))
    )
      allowed.add(id)
  }
  return allowed
}

/**
 * Everybody this reader might read in full (`mayViewFullNames`), and maybe
 * more, but never fewer: what a search over every account narrows to before
 * it asks, so that the asking is bounded by the reader's own reach and not
 * the site's. Undefined for a site admin, who reads everybody.
 *
 * Read after the reader's roles in one query: the reader and the people they
 * are a guardian or family of; and on every level any role of theirs reaches
 * (carried down, as `roleScopes` carries it, with the external teams such a
 * level keeps, the teams closed into those, and the seasons and leagues above
 * them), the members,
 * season and league members, role holders, followers and umpires, with
 * anybody a guardian or family link joins to one of them, through every row
 * closed into another, each by the open row.
 *
 * With `among`, only those of them it holds: the query returns the
 * intersection, not the whole reach.
 */
export async function fullNameReach(
  db: Kysely<Database>,
  readerUserId: string,
  about: { isAdmin: boolean },
  among?: readonly string[]
): Promise<Set<string> | undefined> {
  if (about.isAdmin) return undefined
  if (among?.length === 0) return new Set()
  const narrowed =
    among == null ? sql`` : sql`where id = any(${[...among]}::text[])`
  const roles = await roleScopes(db, readerUserId, false)
  const ids = (key: keyof ScopeSet): string[] => [
    ...new Set(ROLES.flatMap(role => [...roles[role][key]]))
  ]
  const leagues = ids('leagueIds')
  const seasons = ids('seasonIds')
  const teams = ids('teamIds')
  const levels = [...leagues, ...seasons, ...teams]
  const { rows } = await sql<{ id: string }>`
    with recursive
    parents as (
      select season_id, team_id from season_teams
      union
      select season_id, team_id from season_team_parents
    ),
    role_seasons as (
      select unnest(${seasons}::text[]) as id
      union
      select id from seasons where league_id = any(${leagues}::text[])
    ),
    role_teams as (
      select unnest(${teams}::text[]) as id
      union
      select team_id from parents
        where season_id in (select id from role_seasons)
      union
      select id from teams where league_id = any(${leagues}::text[])
      union
      select id from teams
        where kind = 'external' and custodian_id = any(${levels}::text[])
    ),
    -- With every team closed into one of them, whose people it took.
    level_teams as (
      select id from role_teams
      union
      select t.id from teams t join level_teams l on t.merged_into = l.id
    ),
    level_seasons as (
      select id from role_seasons
      union
      select season_id from parents
        where team_id in (select id from level_teams)
    ),
    level_leagues as (
      select unnest(${leagues}::text[]) as id
      union
      select league_id from teams
        where id in (select id from level_teams) and league_id is not null
      union
      select league_id from seasons
        where id in (select id from level_seasons) and league_id is not null
    ),
    level_ids as (
      select id from level_teams
      union select id from level_seasons
      union select id from level_leagues
    ),
    seed as (
      select ${readerUserId}::text as id
      union
      select user_id from memberships
        where team_id in (select id from level_teams)
      union
      select user_id from season_members
        where season_id in (select id from level_seasons)
      union
      select user_id from league_members
        where league_id in (select id from level_leagues)
      union
      select user_id from scope_roles
        where scope_id in (select id from level_ids)
      union
      select user_id from follows where group_id in (select id from level_ids)
      union
      select user_id from league_umpires
        where league_id in (select id from level_leagues)
    ),
    up as (
      select id from seed
      union
      select u.merged_into from users u join up on u.id = up.id
        where u.merged_into is not null
    ),
    rows_of as (
      select id from up
      union
      select u.id from users u join rows_of r on u.merged_into = r.id
    ),
    linked as (
      select id from rows_of
      union
      select related_user_id from user_links
        where kind in ('guardian', 'family')
          and user_id in (select id from rows_of)
      union
      select user_id from user_links
        where kind in ('guardian', 'family')
          and related_user_id in (select id from rows_of)
    ),
    reach as (
      select id from linked
      union
      select u.merged_into from users u join reach r on u.id = r.id
        where u.merged_into is not null
    )
    select id from reach ${narrowed}`.execute(db)
  return new Set(rows.map(row => row.id))
}

/** The levels whose people lists hold one person, as `peopleListLevels` reads them. */
interface ListLevels extends ScopeSet {
  /** The leagues they umpire for, whose administrators open their profile. */
  umpireLeagueIds: Set<string>
}

/**
 * Every level whose people list (`onPeopleList`) holds each of these people,
 * keyed by the id asked about, in a fixed number of reads however many there
 * are: each person's rows (`onePeople`), the players they guard
 * (`guardedPeopleOfEach`), their memberships and those players', their season
 * and league memberships, roles, follows and umpiring, which of them are
 * disabled, the open adds of the teams they and their players are members
 * of or follow, and the levels above the teams they and their players play
 * on and below the levels they belong to. A team an open add brought a person
 * to (`openArrivalsOf`) is on none of their levels, however a season or league
 * above it would carry them down, unless something the add did not bring put
 * them on it: a role on it, or a settled player of it they guard. Somebody
 * the add found on the team already stays where they were.
 */
async function peopleListLevels(
  db: Kysely<Database>,
  asked: readonly string[],
  known: ReadonlyMap<string, OnePerson>
): Promise<Map<string, ListLevels>> {
  const gathered = await onePeople(
    db,
    asked.filter(id => known.get(id)?.userIds.includes(id) !== true)
  )
  const people = new Map(
    asked.map(id => [
      id,
      known.get(id)?.userIds.includes(id) === true
        ? known.get(id)!
        : gathered.get(id)!
    ])
  )
  const guarded = await guardedPeopleOfEach(db, people)
  const ownRows = [...people.values()].flatMap(person => person.userIds)
  const childRows = [...guarded.values()].flatMap(children =>
    children.flatMap(child => child.userIds)
  )
  const [
    memberships,
    seasonMembers,
    leagueMembers,
    roleRows,
    followRows,
    umpireRows,
    disabledRows
  ] = await Promise.all([
    db
      .selectFrom('memberships')
      .select(['user_id', 'team_id', 'is_player'])
      .where('user_id', '=', anyOf([...ownRows, ...childRows]))
      .execute(),
    db
      .selectFrom('season_members')
      .select(['user_id', 'season_id'])
      .where('user_id', '=', anyOf(ownRows))
      .execute(),
    db
      .selectFrom('league_members')
      .select(['user_id', 'league_id'])
      .where('user_id', '=', anyOf(ownRows))
      .execute(),
    db
      .selectFrom('scope_roles')
      .select(['user_id', 'scope_type', 'scope_id'])
      .where('user_id', '=', anyOf(ownRows))
      .execute(),
    db
      .selectFrom('follows')
      .select(['user_id', 'group_type', 'group_id'])
      .where('user_id', '=', anyOf(ownRows))
      .execute(),
    db
      .selectFrom('league_umpires')
      .select(['user_id', 'league_id'])
      .where('user_id', '=', anyOf(ownRows))
      .execute(),
    db
      .selectFrom('users')
      .select('id')
      .where(
        'id',
        '=',
        anyOf([...new Set([...people.values()].map(person => person.userId))])
      )
      .where('disabled_at', 'is not', null)
      .execute()
  ])
  const disabled = new Set(disabledRows.map(row => row.id))
  const byRow = <T extends { user_id: string }>(
    rows: readonly T[]
  ): Map<string, T[]> => {
    const map = new Map<string, T[]>()
    for (const row of rows) {
      const list = map.get(row.user_id)
      if (list == null) map.set(row.user_id, [row])
      else list.push(row)
    }
    return map
  }
  const membershipsOf = byRow(memberships)
  const seasonMembersOf = byRow(seasonMembers)
  const leagueMembersOf = byRow(leagueMembers)
  const rolesOf = byRow(roleRows)
  const followsOf = byRow(followRows)
  const umpiresOf = byRow(umpireRows)
  const of = <T>(map: Map<string, T[]>, rows: readonly string[]): T[] =>
    rows.flatMap(row => map.get(row) ?? [])

  // What the levels a person belongs to carry down: a season's members and
  // role holders are on its teams' lists, a league's on its seasons' and
  // teams' too.
  const belongs = new Map<string, ScopeSet>()
  for (const [id, person] of people) {
    const set = emptyScopes()
    if (!disabled.has(person.userId)) {
      for (const row of of(seasonMembersOf, person.userIds))
        set.seasonIds.add(row.season_id)
      for (const row of of(leagueMembersOf, person.userIds))
        set.leagueIds.add(row.league_id)
      for (const row of of(rolesOf, person.userIds)) {
        if (row.scope_type === 'league') set.leagueIds.add(row.scope_id)
        if (row.scope_type === 'season') set.seasonIds.add(row.scope_id)
        if (row.scope_type === 'team') set.teamIds.add(row.scope_id)
      }
    }
    belongs.set(id, set)
  }
  await inheritSets(db, [...belongs.values()])

  const followedTeams = followRows
    .filter(row => row.group_type === 'team')
    .map(row => row.group_id)
  // Only the teams memberships settle people on and the teams they follow are
  // read, with their open adds; the teams a season or league carries down
  // count for the comparison alone.
  const teamIds = [
    ...new Set([...memberships.map(row => row.team_id), ...followedTeams])
  ]
  const teams =
    teamIds.length === 0
      ? []
      : await db
          .selectFrom('teams')
          .select(['id', 'league_id', 'merged_into'])
          .where('id', '=', anyOf(teamIds))
          .execute()
  const teamOf = new Map(teams.map(team => [team.id, team]))
  const openTeams = teams
    .filter(team => team.merged_into == null)
    .map(team => team.id)
  // Every open add keeps its membership from settling them, and so what it
  // carries up and to their family; only the adds that brought somebody to a
  // team take it off their levels: one who was on it already, in another
  // role, stays where they were (`openArrivalsOf`).
  const [held, arrived] = await Promise.all([
    openAddsOf(db, openTeams),
    openArrivalsOf(db, openTeams)
  ])
  const holds = (
    by: ReadonlyMap<string, Set<string>>,
    team: string,
    rows: readonly string[]
  ): boolean => rows.some(row => by.get(team)?.has(row) === true)
  /** The open teams these rows' memberships settle them on, players only or not. */
  const settledOn = (rows: readonly string[], players: boolean): string[] =>
    of(membershipsOf, rows)
      .filter(row => !players || row.is_player)
      .map(row => row.team_id)
      .filter(
        team =>
          teamOf.has(team) &&
          teamOf.get(team)!.merged_into == null &&
          !holds(held, team, rows)
      )

  /** The teams an open add brought these rows to. */
  const heldOn = (rows: readonly string[]): string[] =>
    of(membershipsOf, rows)
      .map(row => row.team_id)
      .filter(team => holds(arrived, team, rows))

  // The players' teams, and their children's, reach the levels above them.
  const playing = new Map<string, { own: string[]; children: string[] }>()
  for (const [id, person] of people) {
    const children = disabled.has(person.userId)
      ? []
      : (guarded.get(id) ?? []).flatMap(child => settledOn(child.userIds, true))
    playing.set(id, { own: settledOn(person.userIds, true), children })
  }
  const played = [
    ...new Set(
      [...playing.values()].flatMap(each => [...each.own, ...each.children])
    )
  ]
  const parents =
    played.length === 0
      ? []
      : await db
          .selectFrom(permissionParents(db))
          .innerJoin('seasons', 'seasons.id', 'permission_parents.season_id')
          .select([
            'permission_parents.team_id',
            'permission_parents.season_id',
            'seasons.league_id'
          ])
          .where('permission_parents.team_id', '=', anyOf(played))
          .execute()
  const above = new Map<string, Array<(typeof parents)[number]>>()
  for (const row of parents) {
    const list = above.get(row.team_id)
    if (list == null) above.set(row.team_id, [row])
    else list.push(row)
  }

  const levels = new Map<string, ListLevels>()
  for (const [id, person] of people) {
    const level: ListLevels = {
      ...belongs.get(id)!,
      umpireLeagueIds: new Set()
    }
    for (const team of settledOn(person.userIds, false)) level.teamIds.add(team)
    const { own, children } = playing.get(id)!
    for (const team of [...own, ...children]) {
      level.teamIds.add(team)
      const league = teamOf.get(team)?.league_id
      if (league != null) level.leagueIds.add(league)
      for (const row of above.get(team) ?? []) {
        level.seasonIds.add(row.season_id)
        if (row.league_id != null) level.leagueIds.add(row.league_id)
      }
    }
    if (!disabled.has(person.userId))
      for (const row of of(followsOf, person.userIds)) {
        if (row.group_type === 'league') level.leagueIds.add(row.group_id)
        if (row.group_type === 'season') level.seasonIds.add(row.group_id)
        if (row.group_type === 'team') {
          // A follow of a team since merged follows the team it became.
          const team = teamOf.get(row.group_id)
          level.teamIds.add(team?.merged_into ?? row.group_id)
        }
      }
    for (const row of of(umpiresOf, person.userIds))
      level.umpireLeagueIds.add(row.league_id)
    // A team an open add brought them to is on none of their levels by that
    // add, by a follow of it, or by a season or league carried down to it.
    // It stays when something the add did not bring put them there: a role
    // on it, or a settled player of it they guard.
    const kept = new Set([
      ...children,
      ...(disabled.has(person.userId)
        ? []
        : of(rolesOf, person.userIds)
            .filter(row => row.scope_type === 'team')
            .map(row => row.scope_id))
    ])
    for (const team of heldOn(person.userIds))
      if (!kept.has(team)) level.teamIds.delete(team)
    levels.set(id, level)
  }
  return levels
}

/** Whose administrators manage an external team's people. */
interface Custodian {
  type: 'league' | 'season' | 'team'
  id: string
}

/**
 * The custodian of each external team among these, as `canAdminister` reads
 * it: a season, a league, or a full team; a placeholder kept by another
 * placeholder, or by nobody, has none. Two reads however many teams.
 */
async function externalCustodians(
  db: Kysely<Database>,
  teamIds: readonly string[]
): Promise<Map<string, Custodian>> {
  const custodians = new Map<string, Custodian>()
  if (teamIds.length === 0) return custodians
  const external = await db
    .selectFrom('teams')
    .select(['id', 'custodian_type', 'custodian_id'])
    .where('id', '=', anyOf(teamIds))
    .where('kind', '=', 'external')
    .execute()
  const keptByTeams = external
    .filter(team => team.custodian_type === 'team' && team.custodian_id != null)
    .map(team => team.custodian_id!)
  const full = new Set(
    keptByTeams.length === 0
      ? []
      : (
          await db
            .selectFrom('teams')
            .select('id')
            .where('id', '=', anyOf(keptByTeams))
            .where('kind', '=', 'full')
            .execute()
        ).map(team => team.id)
  )
  for (const team of external) {
    if (team.custodian_type == null || team.custodian_id == null) continue
    if (team.custodian_type === 'team' && !full.has(team.custodian_id)) continue
    custodians.set(team.id, {
      type: team.custodian_type,
      id: team.custodian_id
    })
  }
  return custodians
}

/**
 * The teams a person plays on that stand to them as theirs: `teamsPlayedOnNow`
 * less those holding them only by an open add. What a right over the person
 * themself reads, so a new one is safe without knowing about adds.
 */
export async function settledTeams(
  db: Kysely<Database>,
  userIds: readonly string[]
): Promise<string[]> {
  const [plays, held] = await Promise.all([
    teamsPlayedOnNow(db, userIds),
    openAddTeams(db, userIds)
  ])
  return plays.filter(team => !held.includes(team))
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
