import type { Kysely } from 'kysely'

import { publicStaffName } from '../../common/publicStaffName'
import { ROLES } from '../../common/roles'
import { guardedPlayers, roleScopes } from '../access'
import type { Database } from '../db/database'
import { umpireLeagues } from '../umpires/schedule'

/**
 * Who Tess is answering, as she reads it with every request: enough to start
 * from the person's own teams, seasons and leagues without asking. Read on
 * the server, never sent by the client, and never the person's whole name or
 * e-mail address: a name is in its public form ("Mookie B."), as the app
 * shows staff to people outside the team.
 */

/** The most of each list the prompt carries. */
const MAX_ITEMS = 60

export interface UserContext {
  userId: string
  name: string
  siteAdmin: boolean
  /** Each team they belong to or hold a role on, with those roles. */
  teams: Array<{
    teamId: string
    name: string
    shortName: string
    roles: string[]
  }>
  /** Seasons and leagues they administer. */
  seasonsAdministered: Array<{ seasonId: string; name: string }>
  leaguesAdministered: Array<{ leagueId: string; name: string }>
  /** Leagues where they umpire. */
  umpireLeagues: Array<{ leagueId: string; name: string }>
  /** The players they are a guardian of. */
  guardianOf: Array<{ userId: string; name: string }>
}

/** The person's context, read from the database. */
export async function userContext(
  db: Kysely<Database>,
  userId: string,
  isAdmin: boolean
): Promise<UserContext> {
  const user = await db
    .selectFrom('users')
    .select(['first_name', 'last_name', 'display_name'])
    .where('id', '=', userId)
    .executeTakeFirst()
  const scopes = await roleScopes(db, userId, isAdmin)

  // Their own roles, not the every-role-everywhere a site admin holds, which
  // `siteAdmin` says once rather than team by team.
  const roles = new Map<string, Set<string>>()
  const add = (teamId: string, role: string): void => {
    const held = roles.get(teamId) ?? new Set<string>()
    held.add(role)
    roles.set(teamId, held)
  }
  for (const role of ROLES)
    for (const teamId of scopes[role].teamIds) add(teamId, role)
  const memberships = await db
    .selectFrom('memberships')
    .select(['team_id', 'is_player'])
    .where('user_id', '=', userId)
    .execute()
  for (const row of memberships)
    add(row.team_id, row.is_player ? 'player' : 'member')

  const teamIds = [...roles.keys()]
  const teams =
    teamIds.length === 0
      ? []
      : await db
          .selectFrom('teams')
          .select(['id', 'name', 'short_name'])
          .where('id', 'in', teamIds)
          .where('merged_into', 'is', null)
          .orderBy('name')
          .limit(MAX_ITEMS)
          .execute()

  const seasonIds = [...scopes.admin.seasonIds]
  const seasons =
    seasonIds.length === 0
      ? []
      : await db
          .selectFrom('seasons')
          .select(['id', 'name'])
          .where('id', 'in', seasonIds)
          .orderBy('starts_on', 'desc')
          .limit(MAX_ITEMS)
          .execute()
  const leagueIds = [...scopes.admin.leagueIds]
  const leagues =
    leagueIds.length === 0
      ? []
      : await db
          .selectFrom('leagues')
          .select(['id', 'name'])
          .where('id', 'in', leagueIds)
          .orderBy('name')
          .limit(MAX_ITEMS)
          .execute()

  const guardedIds = (await guardedPlayers(db, userId)).slice(0, MAX_ITEMS)
  const guarded =
    guardedIds.length === 0
      ? []
      : await db
          .selectFrom('users')
          .select(['id', 'first_name', 'last_name', 'display_name'])
          .where('id', 'in', guardedIds)
          .orderBy('id')
          .execute()

  return {
    userId,
    name: publicName(user),
    siteAdmin: scopes.isAdmin,
    teams: teams.map(team => ({
      teamId: team.id,
      name: team.name,
      shortName: team.short_name ?? team.name,
      roles: [...(roles.get(team.id) ?? [])]
    })),
    seasonsAdministered: seasons.map(season => ({
      seasonId: season.id,
      name: season.name
    })),
    leaguesAdministered: leagues.map(league => ({
      leagueId: league.id,
      name: league.name
    })),
    umpireLeagues: (await umpireLeagues(db, { userId, isAdmin, scopes: [] }))
      .slice(0, MAX_ITEMS)
      .map(league => ({ leagueId: league.id, name: league.name })),
    guardianOf: guarded.map(child => ({
      userId: child.id,
      name: publicName(child)
    }))
  }
}

function publicName(
  user:
    | {
        first_name: string | null
        last_name: string | null
        display_name: string
      }
    | undefined
): string {
  return publicStaffName({
    firstName: user?.first_name,
    lastName: user?.last_name,
    displayName: user?.display_name
  })
}
