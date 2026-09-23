import type { Kysely } from 'kysely'

import { makeId } from '../../common/ids'
import type { Database } from '../db/database'
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
  /** `owner`, `manager` or `member` for a team; `spectator` or `member` above. */
  role: string
}

export interface ScopePerson {
  userId: number
  displayName: string
  /** Every address on the account, the primary one first. */
  emails: string[]
  teams: Grant[]
  seasons: Grant[]
  leagues: Grant[]
  /** The levels of this tree they administer, if any. */
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

/** Somebody invited by name who has not opened the link yet. */
export interface PendingPerson {
  inviteId: string
  email: string
  code: string
  invitedAt: string
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
    return { leagues: [league], seasons, teams }
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
    .select(['id', 'name'])
    .where('id', '=', scopeId)
    .executeTakeFirst()
  if (team == null) return undefined
  const seasons = await db
    .selectFrom('season_teams')
    .innerJoin('seasons', 'seasons.id', 'season_teams.season_id')
    .select(['seasons.id as id', 'seasons.name as name', 'seasons.league_id'])
    .where('season_teams.team_id', '=', scopeId)
    .execute()
  const leagueIds = seasons
    .map(season => season.league_id)
    .filter((id): id is string => id != null)
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

async function teamsOfSeasons(
  db: Kysely<Database>,
  seasonIds: string[]
): Promise<Array<{ id: string; name: string }>> {
  if (seasonIds.length === 0) return []
  const rows = await db
    .selectFrom('season_teams')
    .innerJoin('teams', 'teams.id', 'season_teams.team_id')
    .select(['teams.id as id', 'teams.name as name'])
    .where('season_teams.season_id', 'in', seasonIds)
    .groupBy(['teams.id', 'teams.name'])
    .orderBy('teams.name')
    .execute()
  return rows
}

/** Everybody holding any grant anywhere in this tree, and which grants. */
export async function peopleInScope(
  db: Kysely<Database>,
  tree: ScopeTree
): Promise<ScopePerson[]> {
  const teamIds = tree.teams.map(team => team.id)
  const seasonIds = tree.seasons.map(season => season.id)
  const leagueIds = tree.leagues.map(league => league.id)
  const named = new Map<string, string>()
  for (const item of [...tree.teams, ...tree.seasons, ...tree.leagues]) {
    named.set(item.id, item.name)
  }

  const people = new Map<number, ScopePerson>()
  const person = (userId: number, displayName: string): ScopePerson => {
    const held = people.get(userId)
    if (held != null) return held
    const made: ScopePerson = {
      userId,
      displayName,
      emails: [],
      teams: [],
      seasons: [],
      leagues: [],
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
        'users.display_name as displayName'
      ])
      .where('memberships.team_id', 'in', teamIds)
      .where('users.merged_into', 'is', null)
      .execute()
    for (const row of rows) {
      person(row.userId, row.displayName).teams.push({
        id: row.teamId,
        name: named.get(row.teamId) ?? row.teamId,
        role: row.role
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
      .selectFrom('admin_roles')
      .innerJoin('users', 'users.id', 'admin_roles.user_id')
      .select([
        'admin_roles.user_id as userId',
        'admin_roles.scope_type as scopeType',
        'admin_roles.scope_id as scopeId',
        'users.display_name as displayName'
      ])
      .where('admin_roles.scope_id', 'in', scopeIds)
      .where('users.merged_into', 'is', null)
      .execute()
    for (const row of rows) {
      // An administrator is listed even with no membership of their own: they
      // are one of the people with access, and the commonest way to lock
      // yourself out is to remove the only one.
      person(row.userId, row.displayName).adminOf.push({
        kind: row.scopeType,
        id: row.scopeId,
        name: named.get(row.scopeId) ?? row.scopeId
      })
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

  return [...people.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName)
  )
}

/** Invitations addressed to one person that nobody has opened yet. */
export async function pendingInvitations(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string
): Promise<PendingPerson[]> {
  const rows = await db
    .selectFrom('invites')
    .select(['id', 'code', 'for_email', 'created_at'])
    .where('scope_type', '=', scopeType)
    .where('scope_id', '=', scopeId)
    .where('for_email', 'is not', null)
    .where('revoked_at', 'is', null)
    .where('uses', '=', 0)
    .orderBy('created_at', 'desc')
    .execute()
  return rows.map(row => ({
    inviteId: row.id,
    email: row.for_email ?? '',
    code: row.code,
    invitedAt: new Date(row.created_at).toISOString()
  }))
}

/**
 * Takes away the access this scope itself grants, and nothing above it.
 *
 * A team's administrator can drop somebody from the team; they cannot drop
 * them from the season, which is not theirs to decide and would quietly
 * remove that person from four other teams as well. The screen says which
 * grants it could not touch rather than pretending.
 */
export async function removeFromScope(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string,
  userId: number
): Promise<{ removed: boolean }> {
  if (scopeType === 'team') {
    const gone = await db
      .deleteFrom('memberships')
      .where('team_id', '=', scopeId)
      .where('user_id', '=', userId)
      .returning(['id'])
      .executeTakeFirst()
    return { removed: gone != null }
  }
  if (scopeType === 'season') {
    const gone = await db
      .deleteFrom('season_members')
      .where('season_id', '=', scopeId)
      .where('user_id', '=', userId)
      .returning(['id'])
      .executeTakeFirst()
    return { removed: gone != null }
  }
  const gone = await db
    .deleteFrom('league_members')
    .where('league_id', '=', scopeId)
    .where('user_id', '=', userId)
    .returning(['id'])
    .executeTakeFirst()
  return { removed: gone != null }
}

/** Gives somebody who already has an account the access this scope grants. */
export async function addToScope(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string,
  userId: number
): Promise<{ added: boolean }> {
  if (scopeType === 'team') {
    const made = await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: scopeId,
        role: 'member',
        is_spectator: true
      })
      .onConflict(oc => oc.columns(['user_id', 'team_id']).doNothing())
      .returning(['id'])
      .executeTakeFirst()
    return { added: made != null }
  }
  if (scopeType === 'season') {
    const made = await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: userId,
        season_id: scopeId,
        role: 'spectator',
        source: 'manual'
      })
      .onConflict(oc => oc.columns(['user_id', 'season_id']).doNothing())
      .returning(['id'])
      .executeTakeFirst()
    return { added: made != null }
  }
  const made = await db
    .insertInto('league_members')
    .values({
      id: makeId('leagueMember'),
      user_id: userId,
      league_id: scopeId,
      role: 'spectator',
      source: 'manual'
    })
    .onConflict(oc => oc.columns(['user_id', 'league_id']).doNothing())
    .returning(['id'])
    .executeTakeFirst()
  return { added: made != null }
}

/** Makes somebody an administrator of this scope. */
export async function addAdmin(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string,
  userId: number,
  grantedBy: number
): Promise<void> {
  await db
    .insertInto('admin_roles')
    .values({
      id: makeId('adminRole'),
      user_id: userId,
      scope_type: scopeType,
      scope_id: scopeId,
      role: 'admin',
      granted_by: grantedBy
    })
    .onConflict(oc =>
      oc.columns(['user_id', 'scope_type', 'scope_id']).doNothing()
    )
    .execute()
}

export async function removeAdmin(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string,
  userId: number
): Promise<void> {
  await db
    .deleteFrom('admin_roles')
    .where('scope_type', '=', scopeType)
    .where('scope_id', '=', scopeId)
    .where('user_id', '=', userId)
    .execute()
}
