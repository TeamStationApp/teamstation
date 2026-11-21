import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { readOnce } from '../db/readOnce'

/** What the rights and game rules read of a team. */
export interface TeamFacts {
  id: string
  kind: 'full' | 'external'
  custodian_type: 'league' | 'season' | 'team' | null
  custodian_id: string | null
  merged_into: string | null
}

/**
 * A team's kind, custodian and merge, or nothing for no such team: one read,
 * and inside `withRolesRead` one read for the transaction, whichever rule
 * asks first.
 */
export async function teamFacts(
  db: Kysely<Database>,
  teamId: string
): Promise<TeamFacts | undefined> {
  return await readOnce(
    db,
    `teams:${teamId}:facts`,
    async () =>
      await db
        .selectFrom('teams')
        .select(['id', 'kind', 'custodian_type', 'custodian_id', 'merged_into'])
        .where('id', '=', teamId)
        .executeTakeFirst()
  )
}
