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

/**
 * `hasRecordedPlays` for many games at once: the ids of those with a
 * recorded at-bat in progress, decided from the row already read, or a play
 * that carries its record, in one read for the rest.
 */
export async function recordedPlaysOf(
  db: Kysely<Database>,
  games: ReadonlyArray<{ id: string; currentPlay: unknown }>
): Promise<Set<string>> {
  const recorded = new Set<string>()
  const rest: string[] = []
  for (const game of games)
    if (
      game.currentPlay != null &&
      typeof game.currentPlay === 'object' &&
      'teamStation' in game.currentPlay
    )
      recorded.add(game.id)
    else rest.push(game.id)
  if (rest.length === 0) return recorded
  const rows = await db
    .selectFrom('events')
    .select('gameId')
    .distinct()
    .where('gameId', 'in', rest)
    .where(sql<boolean>`gumbo ? 'teamStation'`)
    .execute()
  for (const row of rows) recorded.add(row.gameId)
  return recorded
}
