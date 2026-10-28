import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

/**
 * A stat line, box score row or play whose person's part in the game was
 * withdrawn answers under this key instead of the person, so it adds up with
 * the game and never with them.
 */
export const WITHDRAWN_PREFIX = 'withdrawn:'

export function withdrawnKey(requestId: string, gameId: string): string {
  // One game's line: a table across games never adds a placeholder's games
  // up into one person.
  return `${WITHDRAWN_PREFIX}${requestId}:${gameId}`
}

/** Whether an id is a withdrawn line's key rather than a person's. */
export function isWithdrawnKey(id: string | null | undefined): boolean {
  return id?.startsWith(WITHDRAWN_PREFIX) === true
}

/** A person's id as an answer may carry it: none for a withdrawn line. */
export function publicUserId(id: string): string | null {
  return isWithdrawnKey(id) ? null : id
}

/**
 * The games a person's part was withdrawn from, by any of their rows: what
 * their own record (stats, plays, highlights, the teams they played for)
 * leaves out.
 */
export async function withdrawnGames(
  db: Kysely<Database>,
  userIds: readonly string[]
): Promise<string[]> {
  if (userIds.length === 0) return []
  const rows = await db
    .selectFrom('game_withdrawn_players')
    .select('game_id')
    .distinct()
    .where('user_id', 'in', [...userIds])
    .execute()
  return rows.map(row => row.game_id)
}

export interface WithdrawnPlayer {
  gameId: string
  userId: string
  requestId: string
  label: string
  /** The team whose line it is: their part for any other team stays theirs. */
  teamId: string
}

/** Who was withdrawn from these games, and what each reads as there. */
export async function withdrawnPlayers(
  db: Kysely<Database>,
  gameIds: readonly string[]
): Promise<WithdrawnPlayer[]> {
  if (gameIds.length === 0) return []
  return await db
    .selectFrom('game_withdrawn_players')
    .innerJoin('games', 'games.id', 'game_withdrawn_players.game_id')
    .select(eb => [
      'game_withdrawn_players.game_id as gameId',
      'game_withdrawn_players.user_id as userId',
      'game_withdrawn_players.request_id as requestId',
      'game_withdrawn_players.label',
      eb
        .case()
        .when('game_withdrawn_players.side', '=', 'home')
        .then(eb.ref('games.home_team_id'))
        .else(eb.ref('games.away_team_id'))
        .end()
        .as('teamId')
    ])
    .where('game_withdrawn_players.game_id', 'in', [...new Set(gameIds)])
    .execute()
}
