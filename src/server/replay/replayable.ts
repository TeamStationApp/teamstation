import { type Kysely, sql } from 'kysely'

import type { Database } from '../db/database'

/**
 * Whether a game has anything TeamStation scored stored: a play that carries
 * its record, or a recorded at-bat in progress. Only such a game replays.
 */
export async function hasRecordedPlays(
  db: Kysely<Database>,
  gameId: string,
  currentPlay: unknown
): Promise<boolean> {
  if (
    currentPlay != null &&
    typeof currentPlay === 'object' &&
    'teamStation' in currentPlay
  )
    return true
  const row = await db
    .selectFrom('events')
    .select('id')
    .where('gameId', '=', gameId)
    .where(sql<boolean>`gumbo ? 'teamStation'`)
    .limit(1)
    .executeTakeFirst()
  return row != null
}
