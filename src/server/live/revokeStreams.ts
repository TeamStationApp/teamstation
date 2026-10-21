import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

/**
 * Closes every stream key these accounts hold that could still publish, and
 * says why on each, so a camera that tries again is told to ask for a new URL.
 * Suspension and deletion both call this; a key is video published as
 * somebody, and somebody who can no longer sign in can no longer publish.
 */
export async function revokeStreams(
  db: Kysely<Database>,
  userIds: readonly string[],
  reason: string,
  at = new Date()
): Promise<void> {
  if (userIds.length === 0) return
  await db
    .updateTable('live_streams')
    .set({
      state: 'revoked',
      closes_at: at,
      updated_at: at,
      last_error: reason
    })
    .where('user_id', 'in', [...userIds])
    .where('state', 'in', ['idle', 'publishing'])
    .execute()
}
