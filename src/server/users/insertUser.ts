import { type Insertable, type Kysely, sql } from 'kysely'

import { unavailable } from '../../common/errors'
import { asUserId, type GumboId, type UserId } from '../../common/userId'
import type { Database, UsersTable } from '../db/database'
import { mintUserId } from './mintUserId'

/** The database owns allocation and collision handling inside the caller's transaction. */
export async function ensureGumboId(
  db: Kysely<Database>,
  userId: UserId
): Promise<GumboId> {
  const result = await sql<{
    id: number
  }>`select ts_ensure_gumbo_id(${asUserId(userId)}) as id`.execute(db)
  return result.rows[0].id
}

/** Read-only: adult accounts may have no scoring identity. */
export async function gumboIdOf(
  db: Kysely<Database>,
  userId: UserId
): Promise<GumboId | null> {
  const row = await db
    .selectFrom('gumbo_ids')
    .select('gumbo_id')
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return row?.gumbo_id ?? null
}

/** Mint without an existence scan; the successful insert reserves the identity. */
export async function insertUser(
  db: Kysely<Database>,
  values: Omit<Insertable<UsersTable>, 'id' | 'legacyId'>,
  draw: () => UserId = mintUserId
): Promise<UserId> {
  const insert = async (trx: Kysely<Database>): Promise<UserId> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = asUserId(draw())
      const row = await trx
        .insertInto('users')
        .values({ ...values, id })
        .onConflict(oc => oc.column('id').doNothing())
        .returning('id')
        .executeTakeFirst()
      if (row == null) continue
      return id
    }
    throw unavailable('Five account identity allocations exhausted')
  }
  return db.isTransaction
    ? await insert(db)
    : await db.transaction().execute(insert)
}
