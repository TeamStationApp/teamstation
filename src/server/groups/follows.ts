import type { Kysely } from 'kysely'

import type { GroupRef } from '../../common/groupCreation'
import type { Database } from '../db/database'

/** All application writers lock the canonical table before its legacy mirror. */
export async function setFollow(
  db: Kysely<Database>,
  userId: number,
  ref: GroupRef,
  following: boolean
): Promise<void> {
  if (following) {
    await db
      .insertInto('follows')
      .values({ user_id: userId, group_type: ref.kind, group_id: ref.id })
      .onConflict(oc => oc.doNothing())
      .execute()
  } else {
    await db
      .deleteFrom('follows')
      .where('user_id', '=', userId)
      .where('group_type', '=', ref.kind)
      .where('group_id', '=', ref.id)
      .execute()
  }
}
