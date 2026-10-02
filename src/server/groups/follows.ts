import type { Kysely } from 'kysely'

import type { GroupRef } from '../../common/groupCreation'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import { groupScopeIds, noteScopeChange } from '../socket/syncRevision'

/** All application writers lock the canonical table before its legacy mirror. */
export async function setFollow(
  db: Kysely<Database>,
  userId: number,
  ref: GroupRef,
  following: boolean
): Promise<void> {
  await atomic(db, async trx => {
    const changed = following
      ? await trx
      .insertInto('follows')
      .values({ user_id: userId, group_type: ref.kind, group_id: ref.id })
      .onConflict(oc => oc.doNothing())
      .returning('user_id')
      .executeTakeFirst()
      : await trx
      .deleteFrom('follows')
      .where('user_id', '=', userId)
      .where('group_type', '=', ref.kind)
      .where('group_id', '=', ref.id)
      .returning('user_id')
      .executeTakeFirst()
    if (changed != null)
      noteScopeChange(trx, { userId, ...groupScopeIds(ref.kind, ref.id) })
  })
}
