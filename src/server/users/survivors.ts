import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

export class UnresolvedAccount extends Error {}

/** Who each of these ids is now, for a read that has rows rather than a name. */
export async function survivorsOf(
  db: Kysely<Database>,
  userIds: string[]
): Promise<Map<string, string>> {
  const next = new Map<string, string | null>()
  let pending = [...new Set(userIds)]
  while (pending.length > 0) {
    const rows = await db
      .selectFrom('users')
      .select(['id', 'merged_into'])
      .where('id', 'in', pending)
      .execute()
    if (rows.length !== pending.length)
      throw new UnresolvedAccount('Missing account in merge chain')
    for (const row of rows) next.set(row.id, row.merged_into)
    pending = [
      ...new Set(
        rows.flatMap(row =>
          row.merged_into == null || next.has(row.merged_into)
            ? []
            : [row.merged_into]
        )
      )
    ]
  }
  const survivors = new Map<string, string>()
  for (const source of userIds) {
    const seen = new Set<string>()
    let id = source
    while (next.get(id) != null) {
      if (seen.has(id)) throw new UnresolvedAccount('Cyclic account merge')
      seen.add(id)
      id = next.get(id)!
    }
    survivors.set(source, id)
  }
  return survivors
}
