import type { Kysely } from 'kysely'

import {
  type ScoringUpdate,
  storedScoringUpdates
} from '../../common/scoring/updates'
import type { Database } from '../db/database'
import { shortNamesOf } from '../users/nameBook'
import type { Reader } from '../users/readerNames'
import { survivorsOf } from '../users/survivors'

/** Resolve current names and privacy, including merged-account survivors. */
export async function namedScoringUpdates(
  db: Kysely<Database>,
  mutation: unknown,
  reader?: Reader
): Promise<ScoringUpdate[]> {
  const updates = storedScoringUpdates(mutation)
  const survivors = await survivorsOf(
    db,
    updates.map(update => update.userId)
  )
  const names = await shortNamesOf(db, [...survivors.values()], { reader })
  return updates.map(update => ({
    ...update,
    userId: survivors.get(update.userId)!,
    name: names.get(survivors.get(update.userId)!) ?? ''
  }))
}
