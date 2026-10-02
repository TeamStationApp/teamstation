import type { Kysely } from 'kysely'

import type { Database } from '../db/database'

/** What a scoreboard needs from its game: when, whether, who and the score. */
export interface GameRecord {
  /** Milliseconds. */
  startAt: number
  status: string
  homeTeamId: string
  awayTeamId: string
  homeTeam: string
  awayTeam: string
  homeScore: number | null
  awayScore: number | null
}

/**
 * Whether `gameId` could be one of our ids at all (`makeId` gives a short
 * prefix and base64url). Anything else, a NUL byte or a control character or
 * a page of text, is no game: it is answered as unknown without asking
 * Postgres, which would refuse some of it with an error.
 */
export function mayBeGameId(gameId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(gameId)
}

/** The game's record, or undefined when there is no such game. */
export async function gameRecord(
  db: Kysely<Database>,
  gameId: string
): Promise<GameRecord | undefined> {
  if (!mayBeGameId(gameId)) return undefined
  const row = await db
    .selectFrom('games')
    .innerJoin('teams as home', 'home.id', 'games.home_team_id')
    .innerJoin('teams as away', 'away.id', 'games.away_team_id')
    .select([
      'games.start_at as startAt',
      'games.status as status',
      'games.home_team_id as homeTeamId',
      'games.away_team_id as awayTeamId',
      'home.name as homeTeam',
      'away.name as awayTeam',
      'games.home_score as homeScore',
      'games.away_score as awayScore'
    ])
    .where('games.id', '=', gameId)
    .executeTakeFirst()
  if (row == null) return undefined
  return { ...row, startAt: new Date(row.startAt).getTime() }
}
