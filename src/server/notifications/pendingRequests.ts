import type { SelectQueryBuilder } from 'kysely'

import type { Database } from '../db/database'

export type InboxMode = 'pending' | 'sent' | 'history'

/** Narrow authorized candidates before projection; live authority still decides. */
export function pendingRequests<O>(
  query: SelectQueryBuilder<Database, 'group_requests', O>,
  mode: InboxMode,
  now: Date
): SelectQueryBuilder<Database, 'group_requests', O> {
  if (mode !== 'pending') return query
  return query.where('expires_at', '>', now).where(eb =>
    eb.or([
      eb('status', '=', 'pending'),
      // An applied add can still be rejected by its player's side.
      eb.and([eb('kind', '=', 'playerAdd'), eb('status', '=', 'applied')])
    ])
  )
}
