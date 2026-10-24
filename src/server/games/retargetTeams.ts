import { type Kysely, sql } from 'kysely'

import { retargetRecord } from '../../common/scoring/teamRecord'
import type { Database } from '../db/database'

/**
 * Keeps these games readable after one of their teams was replaced by
 * another: every place a record, or a list kept by team, names the old team
 * by its id names the new one. A record stored before records named teams
 * names sides, and needs nothing.
 */
export async function retargetGameTeams(
  trx: Kysely<Database>,
  gameIds: readonly string[],
  fromTeamId: string,
  toTeamId: string
): Promise<void> {
  if (gameIds.length === 0 || fromTeamId === toTeamId) return
  const plays = await trx
    .selectFrom('events')
    .select(['id', 'gumbo'])
    .where('gameId', 'in', [...gameIds])
    .where(sql<string>`gumbo->'teamStation'->>'version'`, '=', '3')
    // Only a record that names the team: a merge can move many games.
    .where(
      sql<boolean>`strpos((gumbo->'teamStation')::text, ${fromTeamId}) > 0`
    )
    .execute()
  for (const play of plays) {
    const gumbo = play.gumbo as Record<string, unknown>
    await trx
      .updateTable('events')
      .set({
        gumbo: {
          ...gumbo,
          teamStation: retargetRecord(gumbo.teamStation, fromTeamId, toTeamId)
        }
      })
      .where('id', '=', play.id)
      .execute()
  }
  const games = await trx
    .selectFrom('games')
    .select(['id', 'currentPlay'])
    .where('id', 'in', [...gameIds])
    .where(sql<string>`"currentPlay"->'teamStation'->>'version'`, '=', '3')
    .execute()
  for (const game of games) {
    const current = game.currentPlay as Record<string, unknown>
    await trx
      .updateTable('games')
      .set({
        currentPlay: {
          ...current,
          teamStation: retargetRecord(current.teamStation, fromTeamId, toTeamId)
        }
      })
      .where('id', '=', game.id)
      .execute()
  }

  // A game's guests and players left off are kept under its teams' ids.
  for (const column of ['guests', 'unrostered'] as const)
    await sql`update games set ${sql.ref(column)} =
        (${sql.ref(column)} - ${fromTeamId}::text) ||
        jsonb_build_object(${toTeamId}::text, ${sql.ref(column)}->${fromTeamId}::text)
      where id in (${sql.join([...gameIds])}) and ${sql.ref(column)} ? ${fromTeamId}::text`.execute(
      trx
    )
}
