import type { Kysely } from 'kysely'

import { type AgeBand, ageBandOf } from '../../common/age'
import type { Database } from '../db/database'

/**
 * The age band of each of these users on `now`, read in one query. The only
 * reader of `birth_year`, `birth_month` and `is_adult` for chat: chat asks for
 * a band and never reads the columns.
 *
 * Users as they are, not their survivors; an id with no row is left out.
 */
export async function ageBandsOf(
  db: Kysely<Database>,
  userIds: Iterable<string>,
  now: Date
): Promise<Map<string, AgeBand>> {
  const ids = [...new Set(userIds)]
  const bands = new Map<string, AgeBand>()
  if (ids.length === 0) return bands
  const rows = await db
    .selectFrom('users')
    .select(['id', 'birth_year', 'birth_month', 'is_adult'])
    .where('id', 'in', ids)
    .execute()
  for (const row of rows) {
    bands.set(
      row.id,
      ageBandOf(
        {
          birthYear: row.birth_year,
          birthMonth: row.birth_month,
          isAdult: row.is_adult
        },
        now
      )
    )
  }
  return bands
}

/** One user's band on `now`, or undefined when there is no such row. */
export async function ageBandOfUser(
  db: Kysely<Database>,
  userId: string,
  now: Date
): Promise<AgeBand | undefined> {
  return (await ageBandsOf(db, [userId], now)).get(userId)
}
