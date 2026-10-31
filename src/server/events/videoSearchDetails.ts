import type { Kysely } from 'kysely'

import { survivorsOf } from '../admin/people'
import type { Database } from '../db/database'
import { gameLineups } from './teamLineups'
import { lineupParticipantIds } from './videoCollections'

/** The caller supplies only games whose videos the viewer can open. */
export async function videoSearchDetails(
  db: Kysely<Database>,
  gameIds: string[]
): Promise<{
  teams: Map<string, { name: string; leagueName: string | null }>
  players: Map<string, Array<{ id: string; name: string }>>
}> {
  const teams = new Map<string, { name: string; leagueName: string | null }>()
  const players = new Map<string, Array<{ id: string; name: string }>>()
  if (gameIds.length === 0) return { teams, players }
  const games = await db
    .selectFrom('games')
    .leftJoin('seasons', 'seasons.id', 'games.season_id')
    .leftJoin('leagues', 'leagues.id', 'seasons.league_id')
    .select([
      'games.id',
      'games.home_team_id',
      'games.away_team_id',
      'games.currentPlay',
      'games.pregame',
      'seasons.name as seasonName',
      'leagues.name as leagueName'
    ])
    .where('games.id', 'in', [...new Set(gameIds)])
    .orderBy('games.start_at', 'desc')
    .orderBy('games.id', 'asc')
    .execute()
  const identities = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('id', 'in', [
      ...new Set(games.flatMap(g => [g.home_team_id, g.away_team_id]))
    ])
    .execute()
  const names = new Map(identities.map(t => [t.id, t.name]))
  for (const game of games) {
    for (const id of [game.away_team_id, game.home_team_id]) {
      if (!teams.has(id) && game.seasonName !== null)
        teams.set(id, { name: game.seasonName, leagueName: game.leagueName })
    }
    const lineups = await gameLineups(db, game)
    const stats = await db
      .selectFrom('game_player_stats')
      .select(['gumbo_id', 'team_id'])
      .where('game_id', '=', game.id)
      .execute()
    for (const side of ['away', 'home'] as const) {
      const teamId = game[`${side}_team_id`]
      const gumboIds = [
        ...new Set([
          ...lineupParticipantIds([lineups[side]]),
          ...stats.filter(s => s.team_id === teamId).map(s => s.gumbo_id)
        ])
      ]
      if (gumboIds.length === 0) continue
      const rows = await db
        .selectFrom('gumbo_ids')
        .select('user_id')
        .where('gumbo_id', 'in', gumboIds)
        .execute()
      const survivors = await survivorsOf(
        db,
        rows.map(r => r.user_id)
      )
      for (const row of rows) {
        const id = survivors.get(row.user_id)!
        const recent = players.get(id) ?? []
        if (recent.length < 2 && !recent.some(t => t.id === teamId))
          recent.push({ id: teamId, name: names.get(teamId)! })
        players.set(id, recent)
      }
    }
  }
  return { teams, players }
}
