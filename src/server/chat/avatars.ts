import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { imageUrl } from '../media/imageUrls'
import type { MediaContext } from '../media/mediaContext'

interface Scope {
  type: 'team' | 'season' | 'league'
  id: string
}

/** Only the scopes from the caller's authorized conversation rows are read. */
export async function scopeAvatars(
  db: Kysely<Database>,
  space: MediaContext['space'],
  scopes: Scope[]
): Promise<Map<string, { name: string; url: string | null }>> {
  const result = new Map<string, { name: string; url: string | null }>()
  for (const type of ['team', 'season', 'league'] as const) {
    const ids = [
      ...new Set(
        scopes.filter(scope => scope.type === type).map(scope => scope.id)
      )
    ]
    if (ids.length === 0) continue
    const table =
      type === 'team' ? 'teams' : type === 'season' ? 'seasons' : 'leagues'
    const rows = await db
      .selectFrom(table)
      .select(['id', 'name', 'logo_path'])
      .where('id', 'in', ids)
      .execute()
    for (const row of rows) {
      result.set(`${type}:${row.id}`, {
        name: row.name,
        url: imageUrl(space, row.logo_path)
      })
    }
  }
  return result
}
