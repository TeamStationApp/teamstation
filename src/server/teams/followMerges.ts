import type { Kysely, Transaction } from 'kysely'

import type { Database } from '../db/database'
import { teamFacts } from './teamFacts'

/** The team a merged team became, however many merges ago. */
export async function followMerges(
  db: Kysely<Database> | Transaction<Database>,
  teamId: string
): Promise<string> {
  let id = teamId
  const seen = new Set<string>()
  while (!seen.has(id)) {
    seen.add(id)
    const row = await teamFacts(db, id)
    if (row?.merged_into == null) return id
    id = row.merged_into
  }
  return id
}
