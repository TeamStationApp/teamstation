import type { Kysely } from 'kysely'

import type { ChatKind, Database } from '../db/database'

/**
 * A scope chat's title, from the scope's names as they read now. Nothing
 * about a name is stored in the chat, so renaming a team renames its chats.
 *
 * - team chats: `<team> Staff`, `<team> Members`, `<team> Fans`;
 * - season chats: `<season title> Staff`, `… All Staff`, `… Announcements`,
 *   where the season title is `<league name> <season name>` when the season
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

/** `<league name> <season name>`, or the season's own name without one. */
export function seasonTitle(
  seasonName: string,
  leagueName: string | null
): string {
  return leagueName == null ? seasonName : `${leagueName} ${seasonName}`
}

/** The scope's name, as its chats are titled: a team, a season title, a league. */
export async function scopeNames(
  db: Kysely<Database>,
  scopes: Array<{ type: 'team' | 'season' | 'league'; id: string }>
): Promise<Map<string, string>> {
  const ids = (type: string): string[] => [
    ...new Set(scopes.filter(scope => scope.type === type).map(s => s.id))
  ]
  const names = new Map<string, string>()
  const teamIds = ids('team')
  if (teamIds.length > 0) {
    const rows = await db
      .selectFrom('teams')
      .select(['id', 'name'])
      .where('id', 'in', teamIds)
      .execute()
    for (const row of rows) names.set(`team:${row.id}`, row.name)
  }
  const seasonIds = ids('season')
  if (seasonIds.length > 0) {
    const rows = await db
      .selectFrom('seasons')
      .leftJoin('leagues', 'leagues.id', 'seasons.league_id')
      .select(['seasons.id', 'seasons.name', 'leagues.name as leagueName'])
      .where('seasons.id', 'in', seasonIds)
      .execute()
    for (const row of rows) {
      names.set(`season:${row.id}`, seasonTitle(row.name, row.leagueName))
    }
  }
  const leagueIds = ids('league')
  if (leagueIds.length > 0) {
    const rows = await db
      .selectFrom('leagues')
      .select(['id', 'name'])
      .where('id', 'in', leagueIds)
      .execute()
    for (const row of rows) names.set(`league:${row.id}`, row.name)
  }
  return names
}

/** Each conversation's title by id; null for a DM. */
export async function titlesOf(
  db: Kysely<Database>,
  conversations: Titled[]
): Promise<Map<string, string | null>> {
  const scopes = conversations.flatMap(conversation =>
    conversation.scopeType == null || conversation.scopeId == null
      ? []
      : [{ type: conversation.scopeType, id: conversation.scopeId }]
  )
  const names = await scopeNames(db, scopes)
  const titles = new Map<string, string | null>()
  for (const conversation of conversations) {
    if (conversation.kind === 'dm' || conversation.scopeType == null) {
      titles.set(conversation.id, null)
      continue
    }
    const name =
      names.get(`${conversation.scopeType}:${conversation.scopeId ?? ''}`) ??
      'Chat'
    titles.set(conversation.id, `${name} ${SUFFIX[conversation.kind]}`)
  }
  return titles
}
