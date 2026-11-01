import type { Kysely } from 'kysely'

import type { ChatKind, Database } from '../db/database'

/**
 * A scope chat's title, from the scope's names as they read now. Nothing
 * about a name is stored in the chat, so renaming a team renames its chats.
 *
 * - team chats: `<team> Staff`, `<team> Members`, `<team> Fans`;
 * - season chats: `<season title> Staff`, `… All Staff`, `… Announcements`,
 *   where the season title is `<season name> - <league name>` when the season
 *   has a league, and `<season name>` otherwise;
 * - `leagueOrg`: `<league> Org`.
 *
 * A DM has no title (null): the app names it from its members.
 */

const SUFFIX: Record<ChatKind, string> = {
  teamStaff: 'Staff',
  teamMembers: 'Members',
  teamFans: 'Fans',
  seasonStaff: 'Staff',
  seasonAllStaff: 'All Staff',
  seasonAnnouncements: 'Announcements',
  leagueOrg: 'Org',
  dm: ''
}

export interface Titled {
  id: string
  kind: ChatKind
  scopeType: 'team' | 'season' | 'league' | null
  scopeId: string | null
}

export interface Scope {
  type: 'team' | 'season' | 'league'
  id: string
}

/** A scope as its chats show it, from the one read of its row. */
export interface ScopeIdentity {
  /** The scope's own name, for its initials. */
  name: string
  /** The name its chats are titled by: a season's with its league's. */
  scopeName: string
  /** The stored logo, for the caller to sign; never sent as it is. */
  logoPath: string | null
  /** A season's league, for who moderates its chats; null for the rest. */
  leagueId: string | null
}

/** `<season name> - <league name>`, or the season's own name without one. */
export function seasonTitle(
  seasonName: string,
  leagueName: string | null
): string {
  return leagueName == null ? seasonName : `${seasonName} - ${leagueName}`
}

/** The key a scope has in a `scopeIdentities` map. */
export function scopeKey(type: Scope['type'], id: string): string {
  return `${type}:${id}`
}

/** The scopes of the conversations that have one, DMs left out. */
export function scopesOf(conversations: Titled[]): Scope[] {
  return conversations.flatMap(conversation =>
    conversation.scopeType == null || conversation.scopeId == null
      ? []
      : [{ type: conversation.scopeType, id: conversation.scopeId }]
  )
}

/**
 * Each scope's name, title name, logo and (for a season) league, by
 * `scopeKey`: one read of each scope table, and none of a table no scope
 * names. A scope whose row is gone has no entry. Everything a chat shows of
 * its scope comes from this one map, so its title and `scopeName` cannot
 * disagree.
 */
export async function scopeIdentities(
  db: Kysely<Database>,
  scopes: Scope[]
): Promise<Map<string, ScopeIdentity>> {
  const ids = (type: Scope['type']): string[] => [
    ...new Set(scopes.filter(scope => scope.type === type).map(s => s.id))
  ]
  const identities = new Map<string, ScopeIdentity>()
  const teamIds = ids('team')
  if (teamIds.length > 0) {
    const rows = await db
      .selectFrom('teams')
      .select(['id', 'name', 'logo_path'])
      .where('id', 'in', teamIds)
      .execute()
    for (const row of rows) {
      identities.set(scopeKey('team', row.id), {
        name: row.name,
        scopeName: row.name,
        logoPath: row.logo_path,
        leagueId: null
      })
    }
  }
  const seasonIds = ids('season')
  if (seasonIds.length > 0) {
    const rows = await db
      .selectFrom('seasons')
      .leftJoin('leagues', 'leagues.id', 'seasons.league_id')
      .select([
        'seasons.id',
        'seasons.name',
        'seasons.logo_path',
        'seasons.league_id',
        'leagues.name as leagueName'
      ])
      .where('seasons.id', 'in', seasonIds)
      .execute()
    for (const row of rows) {
      identities.set(scopeKey('season', row.id), {
        name: row.name,
        scopeName: seasonTitle(row.name, row.leagueName),
        logoPath: row.logo_path,
        leagueId: row.league_id
      })
    }
  }
  const leagueIds = ids('league')
  if (leagueIds.length > 0) {
    const rows = await db
      .selectFrom('leagues')
      .select(['id', 'name', 'logo_path'])
      .where('id', 'in', leagueIds)
      .execute()
    for (const row of rows) {
      identities.set(scopeKey('league', row.id), {
        name: row.name,
        scopeName: row.name,
        logoPath: row.logo_path,
        leagueId: null
      })
    }
  }
  return identities
}

/**
 * Each conversation's title by id, from its scope's `scopeName` in
 * `identities`; null for a DM, and `Chat …` for a scope that is gone.
 */
export function titlesOf(
  conversations: Titled[],
  identities: Map<string, ScopeIdentity>
): Map<string, string | null> {
  const titles = new Map<string, string | null>()
  for (const conversation of conversations) {
    if (conversation.kind === 'dm' || conversation.scopeType == null) {
      titles.set(conversation.id, null)
      continue
    }
    const name =
      identities.get(
        scopeKey(conversation.scopeType, conversation.scopeId ?? '')
      )?.scopeName ?? 'Chat'
    titles.set(conversation.id, `${name} ${SUFFIX[conversation.kind]}`)
  }
  return titles
}
