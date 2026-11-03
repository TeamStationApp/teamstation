import { sql, type Transaction } from 'kysely'

import { unavailable } from '../../common/errors'
import type { Database } from './database'

/**
 * Takes a transaction-scoped advisory lock on each key, once each, in one
 * sorted order, so two transactions that share keys queue rather than each
 * making the same row, and two that share two keys cannot each hold one.
 * One statement for every key: Postgres evaluates a volatile function in
 * the select list after the sort, so the locks are taken in `k` order. The
 * locks are released when the transaction ends.
 */
export async function lockKeys(
  trx: Transaction<Database>,
  keys: string[]
): Promise<void> {
  const unique = [...new Set(keys)]
  if (unique.length === 0) return
  await sql`select pg_advisory_xact_lock(hashtextextended(k, 0)) from unnest(${unique}::text[]) as k order by k`.execute(
    trx
  )
}

/**
 * `lockKeys`, shared: any number of transactions hold a key together, and
 * one that takes it exclusively waits for all of them, as they wait for it.
 * The same hashing and the same single sorted statement.
 */
export async function lockKeysShared(
  trx: Transaction<Database>,
  keys: string[]
): Promise<void> {
  const unique = [...new Set(keys)]
  if (unique.length === 0) return
  await sql`select pg_advisory_xact_lock_shared(hashtextextended(k, 0)) from unnest(${unique}::text[]) as k order by k`.execute(
    trx
  )
}

/** The key a team merge holds exclusively on each of its two teams. */
export function teamKey(teamId: string): string {
  return `team:${teamId}`
}

/**
 * Taken by a writer of a team's roster or games before any row lock, so it
 * waits for a merge of that team and for no other.
 */
export async function lockTeams(
  trx: Transaction<Database>,
  teamIds: string[]
): Promise<void> {
  await lockKeysShared(trx, teamIds.map(teamKey))
}

/** Reads of a game's teams `lockGameTeams` makes before it gives up. */
export const GAME_TEAMS_ROUNDS = 5

/**
 * Takes the keys of a game's two teams, shared, and answers those teams, or
 * nothing for a game that does not exist. The teams are read with no row
 * lock and read again once their keys are held: a merge that moved the game
 * in between held the old team's key until it committed, so the game names
 * the kept team now, and its key is taken too. Two reads that agree end it.
 * The keys taken for a team the game has left stay held until commit, which
 * keeps nobody waiting: only a merge takes a team key exclusively, and it
 * takes all of its own in one sorted statement before any row.
 */
export async function lockGameTeams(
  trx: Transaction<Database>,
  gameId: string
): Promise<{ homeTeamId: string; awayTeamId: string } | undefined> {
  const read = async (): Promise<
    { homeTeamId: string; awayTeamId: string } | undefined
  > => {
    const row = await trx
      .selectFrom('games')
      .select(['home_team_id', 'away_team_id'])
      .where('id', '=', gameId)
      .executeTakeFirst()
    return row == null
      ? undefined
      : { homeTeamId: row.home_team_id, awayTeamId: row.away_team_id }
  }
  let teams = await read()
  for (let round = 0; round < GAME_TEAMS_ROUNDS; round += 1) {
    if (teams == null) return undefined
    await lockTeams(trx, [teams.homeTeamId, teams.awayTeamId])
    const again = await read()
    if (
      again == null ||
      (again.homeTeamId === teams.homeTeamId &&
        again.awayTeamId === teams.awayTeamId)
    )
      return again
    teams = again
  }
  throw unavailable("This game's teams are being merged; try again")
}
