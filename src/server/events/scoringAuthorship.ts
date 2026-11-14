import type { Kysely } from 'kysely'

import {
  authorshipForWire,
  isEmptyAuthorship,
  type ScoringAuthorship,
  storedAuthorship
} from '../../common/scoring/authorship'
import type { Database } from '../db/database'
import { shortNamesOf } from '../users/nameBook'
import type { Reader } from '../users/readerNames'
import { survivorsOf } from '../users/survivors'

/**
 * A game's stored authorship as a client reads it: merged accounts as their
 * survivors, with each author's short name as `reader` may read it. Nothing
 * for a game whose actions nobody is credited with.
 */
export async function namedScoringAuthorship(
  db: Kysely<Database>,
  raw: unknown,
  reader?: Reader
): Promise<ScoringAuthorship | undefined> {
  const stored = storedAuthorship(raw)
  if (isEmptyAuthorship(stored)) return undefined
  const survivors = await survivorsOf(db, stored.users)
  const survivor = (userId: string): string => survivors.get(userId) ?? userId
  const names = await shortNamesOf(
    db,
    [...new Set(stored.users.map(survivor))],
    {
      reader
    }
  )
  return authorshipForWire(stored, survivor, names)
}
