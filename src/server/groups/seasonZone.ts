import { type Kysely, sql } from 'kysely'

import { badRequest } from '../../common/errors'
import { DEFAULT_SEASON_TIMEZONE } from '../../common/seasonScheduling'
import type { Database } from '../db/database'
import type { Clock } from './requests'

/**
 * A zone a request names, as the platform names it: `america/los_angeles`
 * is stored as `America/Los_Angeles`, so it compares equal to the zone a
 * browser reports. An unknown zone is refused.
 */
export function canonicalTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en', {
      timeZone: timezone
    }).resolvedOptions().timeZone
  } catch {
    throw badRequest('Choose a timezone')
  }
}

/**
 * Supersedes a season's pending participation and parent requests: their
 * terms carry the season's dates and zone, so a change to either needs a
 * fresh request.
 */
export async function supersedeSeasonRequests(
  trx: Kysely<Database>,
  seasonId: string,
  clock: Clock
): Promise<void> {
  await trx
    .updateTable('group_requests')
    .set({ status: 'superseded', resolved_at: clock.now() })
    .where('kind', 'in', ['participation', 'parent'])
    .where('status', '=', 'pending')
    .where(eb =>
      eb.or([
        eb(sql<string>`terms->>'seasonId'`, '=', seasonId),
        sql<boolean>`(terms->'preview'->'expected') ? ${`season:${seasonId}`}`
      ])
    )
    .execute()
}

/**
 * Stores the zone an admin set a season up in, when the season still holds
 * the UTC default: its windows were shown in that zone, so they are built
 * in it. A season with a zone of its own keeps it.
 */
export async function adoptSeasonTimezone(
  trx: Kysely<Database>,
  seasonId: string,
  requested: string,
  clock: Clock
): Promise<void> {
  const timezone = canonicalTimezone(requested)
  const season = await trx
    .selectFrom('seasons')
    .select('timezone')
    .where('id', '=', seasonId)
    .forUpdate()
    .executeTakeFirstOrThrow()
  if (
    season.timezone !== DEFAULT_SEASON_TIMEZONE ||
    timezone === season.timezone
  )
    return
  await trx
    .updateTable('seasons')
    .set({ timezone })
    .where('id', '=', seasonId)
    .execute()
  await supersedeSeasonRequests(trx, seasonId, clock)
}
