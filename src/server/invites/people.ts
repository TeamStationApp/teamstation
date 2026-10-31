import type { Kysely } from 'kysely'

import { conflict } from '../../common/errors'
import { makeId } from '../../common/ids'
import { type Role, type RoleFlag, ROLES } from '../../common/roles'
import { mayEditName, openArrivalsOf } from '../access'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import {
  authorizePersonChange,
  type PersonChangeAuthority,
  refuseRoleWhileHeld,
  requireDirectAdmin
} from '../groups/adminGuard'
import { groupScopeIds, noteScopeChange } from '../socket/syncRevision'
import { shortNamesOf } from '../users/nameBook'
import type { InviteScopeType } from './invites'

/**
 * Who can see a team, a season or a league — and, for each of them, how.
 *
 * The hard part is not the list, it is the "how". Access arrives at three
 * heights: a membership of the team, a membership of the season the team
 * plays in, or a membership of the league that season belongs to. One person
 * often holds more than one — a coach's own child is on the roster, and the
 * coach is also in the league — and an administrator removing somebody needs
 * to see every grant, or they take one away, watch nothing change, and
 * conclude the button is broken.
 *
 * So this reads the whole tree around whatever is being administered and
 * returns each person with the grants they actually hold in it. The screen
 * draws a tick per level; this decides what is true.
 */

export interface ScopeTree {
  leagues: Array<{ id: string; name: string }>
  seasons: Array<{ id: string; name: string }>
  teams: Array<{ id: string; name: string }>
}

export interface Grant {
  id: string
  name: string
  /** `owner`, `manager` or `member` for a team; `member` above. */
  role: string
  /** On a team grant only: whether they play on the team. */
  isPlayer?: boolean
}

export interface ScopePerson {
  userId: string
  displayName: string
  /** Every address on the account, the primary one first. */
  emails: string[]
  teams: Grant[]
  seasons: Grant[]
  leagues: Grant[]
  /**
   * Every role they hold anywhere in this tree, one entry per level, named.
   *
   * A role set above the level being managed is listed under that level, so
   * the page can say "Scorekeeper · from Spring league" rather than showing a
   * right that nothing on the page explains.
   */
  grants: RoleGrant[]
  /**
   * The levels of this tree they administer: `grants` narrowed to `admin`.
   * Kept for the phone builds that read it from before the role flags.
   */
  adminOf: Array<{ kind: InviteScopeType; id: string; name: string }>
  /** When the account was made. */
  createdAt: string
  /**
   * The last time they signed in, and the last time they were here.
   *
   * Two dates because a session lasts a month and a device's lasts half a
   * year: somebody who signed in once in March and has watched every game
   * since would otherwise read as six months gone. Null for an account that
   * has never been used — which, of the accounts brought over from PeerTube,
   * is most of them.
   */
  lastSignInAt: string | null
  lastSeenAt: string | null
}

/** The roles one person holds on one level. */
export interface RoleGrant {
  kind: InviteScopeType
  id: string
  name: string
  /** Administrator first, then the flags in their own order. */
  roles: Role[]
}

/** Somebody invited by name who has not opened the link yet. */
export interface PendingPerson {
  inviteId: string
  email: string
  code: string
  invitedAt: string
  requestId?: string
}

/**
 * Everything around the thing being administered, in both directions.
 *
 * Downwards, because a league's people include the members of its teams.
 * Upwards, because a team's people include whoever joined the season it plays
 * in — that is exactly the access an administrator is trying to understand
 * when they wonder why somebody they never added can watch.
 */
export async function scopeTree(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string
): Promise<ScopeTree | undefined> {
  if (scopeType === 'league') {
    const league = await db
      .selectFrom('leagues')
      .select(['id', 'name'])
      .where('id', '=', scopeId)
      .executeTakeFirst()
    if (league == null) return undefined
    const seasons = await db
      .selectFrom('seasons')
      .select(['id', 'name'])
      .where('league_id', '=', scopeId)
      .execute()
    const teams = await teamsOfSeasons(
      db,
      seasons.map(season => season.id)
    )
    const directTeams = await db
      .selectFrom('teams')
      .select(['id', 'name'])
      .where('league_id', '=', scopeId)
      .execute()
    const merged = new Map(
      [...teams, ...directTeams].map(team => [team.id, team])
    )
    return { leagues: [league], seasons, teams: [...merged.values()] }
  }

  if (scopeType === 'season') {
    const season = await db
      .selectFrom('seasons')
      .select(['id', 'name', 'league_id'])
      .where('id', '=', scopeId)
      .executeTakeFirst()
    if (season == null) return undefined
    const leagues =
      season.league_id == null
        ? []
        : await db
            .selectFrom('leagues')
            .select(['id', 'name'])
            .where('id', '=', season.league_id)
            .execute()
    const teams = await teamsOfSeasons(db, [season.id])
    return {
      leagues,
      seasons: [{ id: season.id, name: season.name }],
      teams
    }
  }

  const team = await db
    .selectFrom('teams')
    .select(['id', 'name', 'league_id'])
    .where('id', '=', scopeId)
    .executeTakeFirst()
  if (team == null) return undefined
  const seasons = await db
    .selectFrom('season_team_parents')
    .innerJoin('seasons', 'seasons.id', 'season_team_parents.season_id')
    .select(['seasons.id as id', 'seasons.name as name', 'seasons.league_id'])
    .where('season_team_parents.team_id', '=', scopeId)
    .execute()
  const leagueIds = seasons
    .map(season => season.league_id)
    .filter((id): id is string => id != null)
  if (team.league_id != null && !leagueIds.includes(team.league_id))
    leagueIds.push(team.league_id)
  const leagues =
    leagueIds.length === 0
      ? []
      : await db
          .selectFrom('leagues')
          .select(['id', 'name'])
          .where('id', 'in', leagueIds)
          .execute()
  return {
    leagues,
    seasons: seasons.map(season => ({ id: season.id, name: season.name })),
    teams: [team]
  }
}

/** Management lists contain direct grants and actual ancestors, never descendants. */
export async function managementPeopleTree(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string,
  seen = new Set<string>()
): Promise<ScopeTree | undefined> {
  const key = `${scopeType}:${scopeId}`
  if (seen.has(key)) return undefined
  seen.add(key)
  const tree = await scopeTree(db, scopeType, scopeId)
  if (tree == null) return undefined
  if (scopeType === 'league')
    return { leagues: tree.leagues, seasons: [], teams: [] }
  if (scopeType === 'season')
    return { leagues: tree.leagues, seasons: tree.seasons, teams: [] }
  const team = await db
    .selectFrom('teams')
    .select(['custodian_type', 'custodian_id'])
    .where('id', '=', scopeId)
    .executeTakeFirstOrThrow()
  if (team.custodian_type != null && team.custodian_id != null) {
    const parent = await managementPeopleTree(
      db,
      team.custodian_type,
      team.custodian_id,
      seen
    )
    if (parent != null) {
      for (const level of ['leagues', 'seasons', 'teams'] as const)
        tree[level] = [
          ...new Map(
            [...tree[level], ...parent[level]].map(group => [group.id, group])
          ).values()
        ]
    }
  }
  return tree
}

async function teamsOfSeasons(
  db: Kysely<Database>,
  seasonIds: string[]
): Promise<Array<{ id: string; name: string }>> {
  if (seasonIds.length === 0) return []
  const rows = await db
    .selectFrom('season_team_parents')
    .innerJoin('teams', 'teams.id', 'season_team_parents.team_id')
    .select(['teams.id as id', 'teams.name as name'])
    .where('season_team_parents.season_id', 'in', seasonIds)
    .groupBy(['teams.id', 'teams.name'])
    .orderBy('teams.name')
    .execute()
  return rows
}

/** Everybody holding any grant anywhere in this tree, and which grants. */
export async function peopleInScope(
  db: Kysely<Database>,
  tree: ScopeTree,
  viewer: { isAdmin: boolean; userId?: string } = { isAdmin: false }
): Promise<ScopePerson[]> {
  const teamIds = tree.teams.map(team => team.id)
  const seasonIds = tree.seasons.map(season => season.id)
  const leagueIds = tree.leagues.map(league => league.id)
  const named = new Map<string, string>()
  for (const item of [...tree.teams, ...tree.seasons, ...tree.leagues]) {
    named.set(item.id, item.name)
  }

  const people = new Map<string, ScopePerson>()
  const person = (userId: string, displayName: string): ScopePerson => {
    const held = people.get(userId)
    if (held != null) return held
    const made: ScopePerson = {
      userId,
      displayName,
      emails: [],
      teams: [],
      seasons: [],
      leagues: [],
      grants: [],
      adminOf: [],
      createdAt: '',
      lastSignInAt: null,
      lastSeenAt: null
    }
    people.set(userId, made)
    return made
  }

  if (teamIds.length > 0) {
    const rows = await db
      .selectFrom('memberships')
      .innerJoin('users', 'users.id', 'memberships.user_id')
      .select([
        'memberships.user_id as userId',
        'memberships.team_id as teamId',
        'memberships.role as role',
        'memberships.is_player as isPlayer',
        'users.display_name as displayName'
      ])
      .where('memberships.team_id', 'in', teamIds)
      .where('users.merged_into', 'is', null)
      .execute()
    for (const row of rows) {
      person(row.userId, row.displayName).teams.push({
        id: row.teamId,
        name: named.get(row.teamId) ?? row.teamId,
        role: row.role,
        isPlayer: row.isPlayer
      })
    }
  }

  if (seasonIds.length > 0) {
    const rows = await db
      .selectFrom('season_members')
      .innerJoin('users', 'users.id', 'season_members.user_id')
      .select([
        'season_members.user_id as userId',
        'season_members.season_id as seasonId',
        'season_members.role as role',
        'users.display_name as displayName'
      ])
      .where('season_members.season_id', 'in', seasonIds)
      .where('users.merged_into', 'is', null)
      .execute()
    for (const row of rows) {
      person(row.userId, row.displayName).seasons.push({
        id: row.seasonId,
        name: named.get(row.seasonId) ?? row.seasonId,
        role: row.role
      })
    }
  }

  if (leagueIds.length > 0) {
    const rows = await db
      .selectFrom('league_members')
      .innerJoin('users', 'users.id', 'league_members.user_id')
      .select([
        'league_members.user_id as userId',
        'league_members.league_id as leagueId',
        'league_members.role as role',
        'users.display_name as displayName'
      ])
      .where('league_members.league_id', 'in', leagueIds)
      .where('users.merged_into', 'is', null)
      .execute()
    for (const row of rows) {
      person(row.userId, row.displayName).leagues.push({
        id: row.leagueId,
        name: named.get(row.leagueId) ?? row.leagueId,
        role: row.role
      })
    }
  }

  const scopeIds = [...teamIds, ...seasonIds, ...leagueIds]
  if (scopeIds.length > 0) {
    const rows = await db
      .selectFrom('scope_roles')
      .innerJoin('users', 'users.id', 'scope_roles.user_id')
      .select([
        'scope_roles.user_id as userId',
        'scope_roles.scope_type as scopeType',
        'scope_roles.scope_id as scopeId',
        'scope_roles.role as role',
        'users.display_name as displayName'
      ])
      .where('scope_roles.scope_id', 'in', scopeIds)
      .where('users.merged_into', 'is', null)
      .execute()
    for (const row of rows) {
      // Somebody holding a role is listed even with no membership of their
      // own: they are one of the people with access, and the commonest way
      // to lock yourself out is to remove the only administrator.
      const held = person(row.userId, row.displayName)
      let grant = held.grants.find(
        item => item.kind === row.scopeType && item.id === row.scopeId
      )
      if (grant == null) {
        grant = {
          kind: row.scopeType,
          id: row.scopeId,
          name: named.get(row.scopeId) ?? row.scopeId,
          roles: []
        }
        held.grants.push(grant)
      }
      grant.roles.push(row.role)
    }
    for (const held of people.values()) {
      for (const grant of held.grants) {
        grant.roles = ROLES.filter(role => grant.roles.includes(role))
      }
      held.adminOf = held.grants
        .filter(grant => grant.roles.includes('admin'))
        .map(grant => ({ kind: grant.kind, id: grant.id, name: grant.name }))
    }
  }

  if (people.size > 0) {
    const userIds = [...people.keys()]
    const rows = await db
      .selectFrom('user_emails')
      .select(['user_id', 'email', 'is_primary'])
      .where('user_id', 'in', userIds)
      .orderBy('is_primary', 'desc')
      .orderBy('created_at')
      .execute()
    for (const row of rows) people.get(row.user_id)?.emails.push(row.email)

    const made = await db
      .selectFrom('users')
      .select(['id', 'created_at'])
      .where('id', 'in', userIds)
      .execute()
    for (const row of made) {
      const held = people.get(row.id)
      if (held != null) held.createdAt = new Date(row.created_at).toISOString()
    }

    // A revoked or expired session still says when somebody signed in, which
    // is the question being asked: "has this account ever been used, and when
    // was it last", not "are they signed in now".
    const seen = await db
      .selectFrom('auth_sessions')
      .select(eb => [
        'user_id',
        eb.fn.max('created_at').as('lastSignInAt'),
        eb.fn.max('last_used_at').as('lastSeenAt')
      ])
      .where('user_id', 'in', userIds)
      .groupBy('user_id')
      .execute()
    for (const row of seen) {
      const held = people.get(row.user_id)
      if (held == null) continue
      held.lastSignInAt =
        row.lastSignInAt == null
          ? null
          : new Date(row.lastSignInAt).toISOString()
      held.lastSeenAt =
        row.lastSeenAt == null ? null : new Date(row.lastSeenAt).toISOString()
    }
  }

  // Somebody here only through open adds shows as the add gave them: a short
  // name, and no addresses, until their side can no longer reject it.
  if (!viewer.isAdmin) {
    const open = await openArrivalsOf(db, teamIds)
    const everyone = [...people.values()]
    const held: Array<(typeof everyone)[number]> = []
    for (const each of everyone)
      if (
        each.teams.length > 0 &&
        each.seasons.length === 0 &&
        each.leagues.length === 0 &&
        each.teams.every(
          team => open.get(team.id)?.has(each.userId) === true
        ) &&
        // Not from a reader whose rights no add takes away.
        !(
          viewer.userId != null &&
          (await mayEditName(db, viewer.userId, each.userId, viewer))
        )
      )
        held.push(each)
    const names = await shortNamesOf(
      db,
      held.map(each => each.userId)
    )
    for (const each of held)
      Object.assign(each, {
        displayName: names.get(each.userId),
        emails: [],
        lastSignInAt: null,
        lastSeenAt: null
      })
  }

  return [...people.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  )
}

/** Invitations addressed to one person that nobody has opened yet. */
export async function pendingInvitations(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string,
  now = new Date()
): Promise<PendingPerson[]> {
  const rows = await db
    .selectFrom('invites')
    .leftJoin('group_requests', 'group_requests.id', 'invites.request_id')
    .select([
      'invites.id',
      'invites.code',
      'invites.for_email',
      'invites.created_at',
      'invites.request_id'
    ])
    .where('invites.scope_type', '=', scopeType)
    .where('invites.scope_id', '=', scopeId)
    .where('for_email', 'is not', null)
    .where('invites.revoked_at', 'is', null)
    .where('uses', '=', 0)
    .where(eb =>
      eb.or([
        eb('invites.expires_at', 'is', null),
        eb('invites.expires_at', '>', now)
      ])
    )
    .where(eb =>
      eb.or([
        eb('invites.request_id', 'is', null),
        eb.and([
          eb('group_requests.status', '=', 'pending'),
          eb('group_requests.expires_at', '>', now)
        ])
      ])
    )
    .orderBy('invites.created_at', 'asc')
    .execute()
  return rows.map(row => ({
    inviteId: row.id,
    email: row.for_email ?? '',
    code: row.code,
    invitedAt: new Date(row.created_at).toISOString(),
    requestId: row.request_id ?? undefined
  }))
}

/**
 * Takes away the access this scope itself grants, and nothing above it.
 *
 * A team's administrator can drop somebody from the team; they cannot drop
 * them from the season, which is not theirs to decide and would quietly
 * remove that person from four other teams as well. The screen says which
 * grants it could not touch rather than pretending.
 *
 * With `keepPlayer`, a team's player is not taken off it (409, and nothing
 * changed): their membership is their place on its roster, which is the
 * roster's to change. The delete itself skips a player's row, so a roster
 * edit that makes them one while this waits is seen.
 */
export async function removeFromScope(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string,
  userId: string,
  actorId?: string,
  authority: PersonChangeAuthority = 'admin',
  keepPlayer = false
): Promise<{ removed: boolean }> {
  return await atomic(db, async trx => {
    await lockKeys(trx, [
      'creation:parent-graph',
      `group:${scopeType}:${scopeId}`
    ])
    if (actorId != null)
      await authorizePersonChange(
        trx,
        { kind: scopeType, id: scopeId },
        userId,
        actorId,
        false,
        authority
      )
    const roles = await trx
      .deleteFrom('scope_roles')
      .where('scope_type', '=', scopeType)
      .where('scope_id', '=', scopeId)
      .where('user_id', '=', userId)
      .returning('id')
      .execute()
    let removed = roles.length > 0
    if (scopeType === 'team') {
      const gone = await trx
        .deleteFrom('memberships')
        .where('team_id', '=', scopeId)
        .where('user_id', '=', userId)
        .$if(keepPlayer, qb => qb.where('is_player', '=', false))
        .returning('id')
        .executeTakeFirst()
      if (gone == null && keepPlayer) await refusePlayer(trx, scopeId, userId)
      removed ||= gone != null
    } else if (scopeType === 'season') {
      const gone = await trx
        .deleteFrom('season_members')
        .where('season_id', '=', scopeId)
        .where('user_id', '=', userId)
        .returning('id')
        .executeTakeFirst()
      removed ||= gone != null
    } else {
      const gone = await trx
        .deleteFrom('league_members')
        .where('league_id', '=', scopeId)
        .where('user_id', '=', userId)
        .returning('id')
        .executeTakeFirst()
      removed ||= gone != null
    }
    await requireDirectAdmin(trx, { kind: scopeType, id: scopeId })
    if (removed)
      noteScopeChange(trx, { userId, ...groupScopeIds(scopeType, scopeId) })
    return { removed }
  })
}

/** 409 when this person plays for the team: they stay while on its roster. */
async function refusePlayer(
  db: Kysely<Database>,
  teamId: string,
  userId: string
): Promise<void> {
  const player = await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .innerJoin('teams', 'teams.id', 'memberships.team_id')
    .select(['users.display_name as name', 'teams.name as team'])
    .where('memberships.team_id', '=', teamId)
    .where('memberships.user_id', '=', userId)
    .where('memberships.is_player', '=', true)
    .executeTakeFirst()
  if (player != null)
    throw conflict(
      `${player.name} plays for ${player.team}, so stays a member while on its roster.`
    )
}

/**
 * Makes somebody who already has an account a plain member of this level, the
 * same kind of member at every level: a team membership as `member`, or a
 * season or league row as `member`, which reaches every team below it. A row
 * they already have, however strong, is left as it is; `added` says whether
 * one was written.
 *
 * It owns no transaction: it notes the change on the caller's, and the
 * function that opened that one bumps the clock after its last write.
 */
export async function addToScope(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string,
  userId: string
): Promise<{ added: boolean }> {
  if (scopeType === 'team') {
    const made = await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: scopeId,
        role: 'member'
      })
      .onConflict(oc => oc.columns(['user_id', 'team_id']).doNothing())
      .returning(['id'])
      .executeTakeFirst()
    if (made != null) noteScopeChange(db, { userId, teamId: scopeId })
    return { added: made != null }
  }
  if (scopeType === 'season') {
    const made = await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: userId,
        season_id: scopeId,
        role: 'member',
        source: 'manual'
      })
      .onConflict(oc => oc.columns(['user_id', 'season_id']).doNothing())
      .returning(['id'])
      .executeTakeFirst()
    if (made != null) noteScopeChange(db, { userId, seasonId: scopeId })
    return { added: made != null }
  }
  const made = await db
    .insertInto('league_members')
    .values({
      id: makeId('leagueMember'),
      user_id: userId,
      league_id: scopeId,
      role: 'member',
      source: 'manual'
    })
    .onConflict(oc => oc.columns(['user_id', 'league_id']).doNothing())
    .returning(['id'])
    .executeTakeFirst()
  if (made != null) noteScopeChange(db, { userId })
  return { added: made != null }
}

/** The roles somebody holds on this one level, set here and nowhere else. */
export async function rolesAt(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string,
  userId: string
): Promise<Role[]> {
  const rows = await db
    .selectFrom('scope_roles')
    .select(['role'])
    .where('scope_type', '=', scopeType)
    .where('scope_id', '=', scopeId)
    .where('user_id', '=', userId)
    .execute()
  return ROLES.filter(role => rows.some(row => row.role === role))
}

/**
 * Makes somebody's roles on this one level exactly these.
 *
 * A role they keep keeps its row, and so who granted it and when. The rest
 * are taken away and the new ones added, in one transaction, so a reader
 * never sees half of a change. `authority` is whose say it needs (an
 * administrator's unless the caller says otherwise).
 */
export async function setScopeRoles(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string,
  userId: string,
  wanted: { admin: boolean; flags: RoleFlag[] },
  grantedBy: string,
  authority: PersonChangeAuthority = 'admin'
): Promise<Role[]> {
  const roles: Role[] = ROLES.filter(
    role =>
      (role === 'admin' && wanted.admin) ||
      wanted.flags.includes(role as RoleFlag)
  )
  await atomic(db, async trx => {
    await lockKeys(trx, [
      'creation:parent-graph',
      `group:${scopeType}:${scopeId}`
    ])
    await authorizePersonChange(
      trx,
      { kind: scopeType, id: scopeId },
      userId,
      grantedBy,
      wanted.admin,
      authority
    )
    const had = await rolesAt(trx, scopeType, scopeId, userId)
    if (roles.some(role => !had.includes(role)))
      await refuseRoleWhileHeld(
        trx,
        { kind: scopeType, id: scopeId },
        userId,
        grantedBy
      )
    await addToScope(trx, scopeType, scopeId, userId)
    if (scopeType === 'team' && !wanted.admin)
      await trx
        .updateTable('memberships')
        .set({ role: 'member' })
        .where('team_id', '=', scopeId)
        .where('user_id', '=', userId)
        .where('role', 'in', ['owner', 'manager'])
        .execute()
    let gone = trx
      .deleteFrom('scope_roles')
      .where('scope_type', '=', scopeType)
      .where('scope_id', '=', scopeId)
      .where('user_id', '=', userId)
    if (roles.length > 0) gone = gone.where('role', 'not in', roles)
    await gone.execute()
    noteScopeChange(trx, { userId, ...groupScopeIds(scopeType, scopeId) })
    if (roles.length === 0) {
      await requireDirectAdmin(trx, { kind: scopeType, id: scopeId })
      return
    }
    await trx
      .insertInto('scope_roles')
      .values(
        roles.map(role => ({
          id: makeId('scopeRole'),
          user_id: userId,
          scope_type: scopeType,
          scope_id: scopeId,
          role,
          granted_by: grantedBy
        }))
      )
      .onConflict(oc =>
        oc.columns(['user_id', 'scope_type', 'scope_id', 'role']).doNothing()
      )
      .execute()
    await requireDirectAdmin(trx, { kind: scopeType, id: scopeId })
  })
  return roles
}
