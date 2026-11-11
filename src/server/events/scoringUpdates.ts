import type { Kysely } from 'kysely'

import {
  type ScoringUpdate,
  storedScoringUpdates
} from '../../common/scoring/updates'
import type { Database } from '../db/database'
import { shortNamesOf } from '../users/nameBook'
import type { Reader } from '../users/readerNames'

/** Resolve current names and privacy, including merged-account survivors. */
export async function namedScoringUpdates(
  db: Kysely<Database>,
  mutation: unknown,
  reader?: Reader
): Promise<ScoringUpdate[]> {
  const updates = storedScoringUpdates(mutation)
  const names = await shortNamesOf(
    db,
    updates.map(update => update.userId),
    { reader }
  )
  return updates.map(update => ({
    ...update,
    name: names.get(update.userId) ?? ''
  }))
}
