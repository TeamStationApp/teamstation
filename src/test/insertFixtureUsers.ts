import type { Insertable, InsertResult, Kysely } from 'kysely'

import { asUserId, gumboOfUserId, userIdOfGumbo } from '../common/userId'
import type { Database, UsersTable } from '../server/db/database'

type FixtureUser = Omit<Insertable<UsersTable>, 'id'> & { id: number | string }

/** Convert a historical fixture label, or validate an account returned by the API. */
export const fixtureUserId = (id: number | string): string =>
  typeof id === 'number' ? userIdOfGumbo(id) : asUserId(id)

/** Seed historical fixture identities explicitly, preserving their numeric scoring IDs. */
export async function insertFixtureUsers(
  db: Kysely<Database>,
  values: FixtureUser | readonly FixtureUser[]
): Promise<InsertResult[]> {
  const rows = (Array.isArray(values) ? values : [values]).map(
    (row: FixtureUser) => ({
      ...row,
      id: fixtureUserId(row.id)
    })
  )
  const insert = async (trx: Kysely<Database>): Promise<InsertResult[]> => {
    const result = await trx.insertInto('users').values(rows).execute()
    for (const row of rows) {
      const gumboId = gumboOfUserId(row.id)
      if (gumboId != null) {
        await trx
          .insertInto('gumbo_ids')
          .values({ user_id: row.id, gumbo_id: gumboId })
          .execute()
      }
    }
    return result
  }
  return db.isTransaction
    ? await insert(db)
    : await db.transaction().execute(insert)
}
