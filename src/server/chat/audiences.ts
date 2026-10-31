import type { Kysely } from 'kysely'

import { ageOn } from '../../common/age'
import { openAddsOf, openArrivalsOf } from '../access'
import type { ChatKind, Database } from '../db/database'
import { rowsOfPeople, STAFF_ROLES, survivors } from '../teams/teamStaff'

/**
 * Who is in each scope chat: the seven audiences.
 *
 * Every audience is worked out from the roster tables as they stand, never
 * stored: the reconciler diffs it with `chat_members`. Each user id read from
 * a roster table is resolved to its survivor through `merged_into`, and only
 * **eligible** people are kept: an account (unmerged, `login_enabled`) who is
 * not under 13 by the age rule (COPPA; a person with no birth month is not
 * treated as under 13).
 *
 * Direct roles only: a role on a league or season is never a role on its
 * teams here ("only admins of the team, not carried over").
 *
 * | Kind | Members |
 * | --- | --- |
 * | `teamStaff` | team staff: direct `admin`, `coach`, `scorekeeper`, `songkeeper`, and `owner`/`manager` memberships |
 * | `teamMembers` | team staff, the team's players, its plain `member` memberships, and the guardians of its players |
 * | `teamFans` | the team's followers who are no team's player, and team staff |
 * | `seasonStaff` | any direct role on the season or its league |
 * | `seasonAllStaff` | season staff, and team staff of every full team in it |
 * | `seasonAnnouncements` | All Staff, every full team's Members, `season_members`, and the league's `league_members` |
 * | `leagueOrg` | any direct role on the league |
 *
 * A team chat exists only for a full, unmerged team; any other team's
 * audience is empty, so a merged team's chats empty out.
 */

export type ScopeKind = Exclude<ChatKind, 'dm'>
export type ScopeType = 'team' | 'season' | 'league'

export const TEAM_KINDS: readonly ScopeKind[] = [
  'teamStaff',
  'teamMembers',
  'teamFans'
]
export const SEASON_KINDS: readonly ScopeKind[] = [
  'seasonStaff',
  'seasonAllStaff',
  'seasonAnnouncements'
]
export const LEAGUE_KINDS: readonly ScopeKind[] = ['leagueOrg']

/** The chats whose shared membership lets one person name another in a DM. */
export const NAMING_KINDS: readonly ChatKind[] = [
  'teamStaff',
  'teamMembers',
  'seasonStaff',
  'seasonAllStaff',
  'leagueOrg'
]

export function scopeTypeOf(kind: ScopeKind): ScopeType {
  if (TEAM_KINDS.includes(kind)) return 'team'
  if (SEASON_KINDS.includes(kind)) return 'season'
  return 'league'
}

export function kindsOf(type: ScopeType): readonly ScopeKind[] {
  return type === 'team'
    ? TEAM_KINDS
    : type === 'season'
      ? SEASON_KINDS
      : LEAGUE_KINDS
}

/** Under 13 by the age rule; no birth month is never under 13. */
export function isUnder13(
  birthYear: number | null,
  birthMonth: number | null,
  now: Date
): boolean {
  if (birthYear == null || birthMonth == null) return false
  return ageOn(birthYear, birthMonth, now) < 13
}

/**
 * Each of these user ids, resolved to its survivor, kept when that survivor
 * is an account and not under 13.
 */
export async function eligibleSurvivors(
  db: Kysely<Database>,
  userIds: Iterable<string>,
  now: Date
): Promise<Set<string>> {
  const survivorOf = await survivors(db, [...userIds])
  const ids = [...new Set(survivorOf.values())]
  if (ids.length === 0) return new Set()
  const rows = await db
    .selectFrom('users')
    .select(['id', 'birth_year', 'birth_month'])
    .where('id', 'in', ids)
    .where('merged_into', 'is', null)
    .where('login_enabled', '=', true)
    .where('disabled_at', 'is', null)
    .execute()
  return new Set(
    rows
      .filter(row => !isUnder13(row.birth_year, row.birth_month, now))
      .map(row => row.id)
  )
}

/** Whether one user (as they are, not their survivor) is eligible now. */
export async function isEligible(
  db: Kysely<Database>,
  userId: string,
  now: Date
): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select(['birth_year', 'birth_month'])
    .where('id', '=', userId)
    .where('merged_into', 'is', null)
    .where('login_enabled', '=', true)
    .where('disabled_at', 'is', null)
    .executeTakeFirst()
  return row != null && !isUnder13(row.birth_year, row.birth_month, now)
}

/** Which of these teams are full and unmerged. */
export async function fullTeams(
  db: Kysely<Database>,
  teamIds: string[]
): Promise<string[]> {
  if (teamIds.length === 0) return []
  const rows = await db
    .selectFrom('teams')
    .select(['id'])
    .where('id', 'in', teamIds)
    .where('kind', '=', 'full')
    .where('merged_into', 'is', null)
    .execute()
  return rows.map(row => row.id)
}

/** The full, unmerged teams playing in a season. */
export async function seasonFullTeams(
  db: Kysely<Database>,
  seasonId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom('season_teams')
    .innerJoin('teams', 'teams.id', 'season_teams.team_id')
    .select(['teams.id'])
    .where('season_teams.season_id', '=', seasonId)
    .where('teams.kind', '=', 'full')
    .where('teams.merged_into', 'is', null)
    .execute()
  return rows.map(row => row.id)
}

/** Team staff, as raw user ids: direct staff roles and owners/managers. */
export async function teamStaffIds(
  db: Kysely<Database>,
  teamIds: string[]
): Promise<string[]> {
  if (teamIds.length === 0) return []
  const roles = await db
    .selectFrom('scope_roles')
    .select(['user_id'])
    .where('scope_type', '=', 'team')
    .where('scope_id', 'in', teamIds)
    .where('role', 'in', [...STAFF_ROLES])
    .execute()
  const owners = await db
    .selectFrom('memberships')
    .select(['user_id'])
    .where('team_id', 'in', teamIds)
    .where('role', 'in', ['owner', 'manager'])
    .execute()
  return [...roles, ...owners].map(row => row.user_id)
}

/** Holders of any direct role on these leagues, as raw user ids. */
export async function leagueRoleIds(
  db: Kysely<Database>,
  leagueIds: string[]
): Promise<string[]> {
  if (leagueIds.length === 0) return []
  const rows = await db
    .selectFrom('scope_roles')
    .select(['user_id'])
    .where('scope_type', '=', 'league')
    .where('scope_id', 'in', leagueIds)
    .execute()
  return rows.map(row => row.user_id)
}

/** Season staff: any direct role on the season or on its league. */
export async function seasonStaffIds(
  db: Kysely<Database>,
  seasonIds: string[]
): Promise<string[]> {
  if (seasonIds.length === 0) return []
  const roles = await db
    .selectFrom('scope_roles')
    .select(['user_id'])
    .where('scope_type', '=', 'season')
    .where('scope_id', 'in', seasonIds)
    .execute()
  const leagues = await db
    .selectFrom('seasons')
    .select(['league_id'])
    .where('id', 'in', seasonIds)
    .where('league_id', 'is not', null)
    .execute()
  const leagueIds = leagues.flatMap(row =>
    row.league_id == null ? [] : [row.league_id]
  )
  return [
    ...roles.map(row => row.user_id),
    ...(await leagueRoleIds(db, leagueIds))
  ]
}

/** A team's Members audience before eligibility: raw user ids. */
async function teamMemberIds(
  db: Kysely<Database>,
  teamIds: string[]
): Promise<string[]> {
  if (teamIds.length === 0) return []
  const people = await db
    .selectFrom('memberships')
    .select(['user_id', 'team_id'])
    .where('team_id', 'in', teamIds)
    .where(eb =>
      eb.or([
        eb('is_player', '=', true),
        eb.and([eb('role', '=', 'member'), eb('is_player', '=', false)])
      ])
    )
    .execute()
  // Neither somebody an open add brought to the team, nor the guardians of
  // anybody it holds so, until it can no longer be rejected: a player without
  // their parents is no better in the team's chat than a parent without their
  // child. Somebody on the team before the add stays in its chat.
  const open = await openArrivalsOf(db, teamIds)
  return [
    ...(await teamStaffIds(db, teamIds)),
    ...people
      .filter(row => open.get(row.team_id)?.has(row.user_id) !== true)
      .map(row => row.user_id),
    ...(await teamGuardianRows(db, teamIds))
  ]
}

/**
 * The guardians of the players on these teams, as the rows their links were
 * made from, for the caller to resolve. A link names the row the child had
 * when it was made, which a merge may since have closed into the row on the
 * team, so each player is asked about with every row that is them.
 */
export async function teamGuardianRows(
  db: Kysely<Database>,
  teamIds: string[]
): Promise<string[]> {
  if (teamIds.length === 0) return []
  const rows = await db
    .selectFrom('memberships')
    .select(['user_id', 'team_id'])
    .where('team_id', 'in', teamIds)
    .where('is_player', '=', true)
    .execute()
  // Not the guardians of somebody a team holds only by an open add: who they
  // are is not that team's to read until the add can no longer be rejected.
  const open = await openAddsOf(db, teamIds)
  const players = rows.filter(
    row => open.get(row.team_id)?.has(row.user_id) !== true
  )
  if (players.length === 0) return []
  const links = await db
    .selectFrom('user_links')
    .select(['user_id'])
    .where('kind', '=', 'guardian')
    .where(
      'related_user_id',
      'in',
      await rowsOfPeople(
        db,
        players.map(row => row.user_id)
      )
    )
    .execute()
  return links.map(link => link.user_id)
}

/** Survivors who hold an `is_player` membership on any team. */
async function playersAmong(
  db: Kysely<Database>,
  survivorIds: string[]
): Promise<Set<string>> {
  if (survivorIds.length === 0) return new Set()
  // Every row of these people, so a closed row's place still counts.
  const rows = await db
    .selectFrom('users')
    .select(['id'])
    .where(eb =>
      eb.or([eb('id', 'in', survivorIds), eb('merged_into', 'in', survivorIds)])
    )
    .execute()
  const memberships = await db
    .selectFrom('memberships')
    .select(['user_id', 'team_id'])
    .where(
      'user_id',
      'in',
      rows.map(row => row.id)
    )
    .where('is_player', '=', true)
    .execute()
  // A team holding them only by an open add does not make them a player: they
  // are in no team's chat for it, and stay among its fans.
  const open = await openAddsOf(
    db,
    memberships.map(row => row.team_id)
  )
  const players = memberships.filter(
    row => open.get(row.team_id)?.has(row.user_id) !== true
  )
  const survivorOf = await survivors(
    db,
    players.map(row => row.user_id)
  )
  return new Set(survivorOf.values())
}

/** Who belongs in one scope chat now. */
export async function audienceOf(
  db: Kysely<Database>,
  kind: ScopeKind,
  scopeId: string,
  now: Date
): Promise<Set<string>> {
  switch (kind) {
    case 'teamStaff': {
      const teams = await fullTeams(db, [scopeId])
      return await eligibleSurvivors(db, await teamStaffIds(db, teams), now)
    }
    case 'teamMembers': {
      const teams = await fullTeams(db, [scopeId])
      return await eligibleSurvivors(db, await teamMemberIds(db, teams), now)
    }
    case 'teamFans': {
      const teams = await fullTeams(db, [scopeId])
      if (teams.length === 0) return new Set()
      const follows = await db
        .selectFrom('team_follows')
        .select(['user_id'])
        .where('team_id', '=', scopeId)
        .execute()
      const fans = await eligibleSurvivors(
        db,
        follows.map(row => row.user_id),
        now
      )
      const players = await playersAmong(db, [...fans])
      const staff = await eligibleSurvivors(
        db,
        await teamStaffIds(db, teams),
        now
      )
      return new Set([...[...fans].filter(id => !players.has(id)), ...staff])
    }
    case 'seasonStaff':
      return await eligibleSurvivors(
        db,
        await seasonStaffIds(db, [scopeId]),
        now
      )
    case 'seasonAllStaff': {
      const teams = await seasonFullTeams(db, scopeId)
      return await eligibleSurvivors(
        db,
        [
          ...(await seasonStaffIds(db, [scopeId])),
          ...(await teamStaffIds(db, teams))
        ],
        now
      )
    }
    case 'seasonAnnouncements': {
      const teams = await seasonFullTeams(db, scopeId)
      const seasonMembers = await db
        .selectFrom('season_members')
        .select(['user_id'])
        .where('season_id', '=', scopeId)
        .execute()
      const leagueMembers = await db
        .selectFrom('league_members')
        .innerJoin('seasons', 'seasons.league_id', 'league_members.league_id')
        .select(['league_members.user_id'])
        .where('seasons.id', '=', scopeId)
        .execute()
      return await eligibleSurvivors(
        db,
        [
          ...(await seasonStaffIds(db, [scopeId])),
          ...(await teamMemberIds(db, teams)),
          ...seasonMembers.map(row => row.user_id),
          ...leagueMembers.map(row => row.user_id)
        ],
        now
      )
    }
    case 'leagueOrg':
      return await eligibleSurvivors(
        db,
        await leagueRoleIds(db, [scopeId]),
        now
      )
  }
}
