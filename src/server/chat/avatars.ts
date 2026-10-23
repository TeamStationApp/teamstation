import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'
import { seasonTitle } from './titles'

interface Scope {
  type: 'team' | 'season' | 'league'
  id: string
}

/** A scope as its chats show it, from one read of its row. */
export interface ScopeIdentity {
  /** The scope's own name, for its initials. */
  name: string
  /** The name its chats are titled by: a season's with its league's. */
  scopeName: string
  url: string | null
}

/** Only the scopes from the caller's authorized conversation rows are read. */
export async function scopeAvatars(
  db: Kysely<Database>,
  space: MediaContext['space'],
  scopes: Scope[]
): Promise<Map<string, ScopeIdentity>> {
  const ids = (type: Scope['type']): string[] => [
    ...new Set(scopes.filter(scope => scope.type === type).map(s => s.id))
  ]
  const result = new Map<string, ScopeIdentity>()
  const teamIds = ids('team')
  if (teamIds.length > 0) {
    const rows = await db
      .selectFrom('teams')
      .select(['id', 'name', 'logo_path'])
      .where('id', 'in', teamIds)
      .execute()
    for (const row of rows) {
      result.set(`team:${row.id}`, {
        name: row.name,
        scopeName: row.name,
        url: imageUrl(space, row.logo_path)
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
        'leagues.name as leagueName'
      ])
      .where('seasons.id', 'in', seasonIds)
      .execute()
    for (const row of rows) {
      result.set(`season:${row.id}`, {
        name: row.name,
        scopeName: seasonTitle(row.name, row.leagueName),
        url: imageUrl(space, row.logo_path)
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
      result.set(`league:${row.id}`, {
        name: row.name,
        scopeName: row.name,
        url: imageUrl(space, row.logo_path)
      })
    }
  }
  return result
}
