import type { Kysely } from 'kysely'

import { checkLimits, recordAttempts } from '../auth/rateLimit'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'

/** City and event lookups share a paid-provider budget for each account. */
export async function limitGoogleLookup(
  db: Kysely<Database>,
  userId: string,
  details: boolean
): Promise<void> {
  await atomic(db, async trx => {
    await lockKeys(trx, [`city-lookup:${userId}`])
    const rules = [
      {
        scope: details ? 'city.details' : 'city.autocomplete',
        key: String(userId),
        limit: details ? 30 : 120,
        windowSec: 60,
        fixed: true
      }
    ]
    await checkLimits(trx, rules)
    await recordAttempts(trx, rules)
  })
}
