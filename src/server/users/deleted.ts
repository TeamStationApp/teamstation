import type { Kysely } from 'kysely'

import { notFound } from '../../common/errors'
import type { Database } from '../db/database'

/** Whether the person behind this row deleted their account. */
export async function isDeleted(
  db: Kysely<Database>,
  userId: string
): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('deleted_at')
    .where('id', '=', userId)
    .executeTakeFirst()
  return row?.deleted_at != null
}

/**
 * Answers 404, as for nobody, when somebody would write a deleted person's
 * name, hands or picture: whoever still runs their old team cannot put a real
 * name or face back on "Deleted user".
 */
export async function refuseDeleted(
  db: Kysely<Database>,
  userId: string
): Promise<void> {
  if (await isDeleted(db, userId)) throw notFound()
}
