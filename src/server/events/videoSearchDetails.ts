import type { Kysely } from 'kysely'

import { survivorsOf } from '../admin/people'
import type { Database } from '../db/database'
import { gameLineups } from './teamLineups'
import { lineupParticipantIds } from './videoCollections'

/** The caller supplies only games whose videos the viewer can open. */
export async function videoSearchDetails(
  db: Kysely<Database>,
  gameIds: string[],
  includePlayers = false
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
  for (const game of games) {
    for (const id of [game.away_team_id, game.home_team_id]) {
      if (!teams.has(id) && game.seasonName !== null)
        teams.set(id, { name: game.seasonName, leagueName: game.leagueName })
    }
  }
  if (!includePlayers) return { teams, players }
  const recorded = await db
    .selectFrom('event_players')
    .innerJoin('events', 'events.id', 'event_players.event_id')
    .select([
      'events.gameId',
      'events.battingTeamId',
      'event_players.gumbo_id',
      'event_players.team_id',
      'event_players.role'
    ])
    .where('events.gameId', 'in', gameIds)
    .where('events.hidden', '=', false)
    .execute()
  const allStats = await db
    .selectFrom('game_player_stats')
    .select(['game_id', 'gumbo_id', 'team_id'])
    .where('game_id', 'in', gameIds)
    .execute()
  const identities = await db
    .selectFrom('teams')
    .select(['id', 'name'])
    .where('id', 'in', [
      ...new Set(games.flatMap(g => [g.home_team_id, g.away_team_id]))
    ])
    .execute()
  const names = new Map(identities.map(t => [t.id, t.name]))
  const appearances: Array<{ gumboId: number; teamId: string | null }> = []
  for (const game of games) {
    const lineups = await gameLineups(db, game)
    for (const side of ['away', 'home'] as const) {
      const teamId = game[`${side}_team_id`]
      appearances.push(
        ...lineupParticipantIds([lineups[side]]).map(gumboId => ({
          gumboId,
          teamId
        }))
      )
    }
    appearances.push(
      ...allStats
        .filter(s => s.game_id === game.id)
        .map(s => ({ gumboId: s.gumbo_id, teamId: s.team_id }))
    )
    for (const event of recorded.filter(e => e.gameId === game.id)) {
      // A missing team is attributable only when the recorded batting side is known.
      const batting = [game.home_team_id, game.away_team_id].includes(
        event.battingTeamId ?? ''
      )
        ? event.battingTeamId
        : null
      const offensive = ['batter', 'runner', 'scorer'].includes(event.role)
      const teamId =
        event.team_id ??
        (batting === null
          ? null
          : offensive
            ? batting
            : batting === game.home_team_id
              ? game.away_team_id
              : game.home_team_id)
      appearances.push({ gumboId: event.gumbo_id, teamId })
    }
  }
  const gumboIds = [...new Set(appearances.map(a => a.gumboId))]
  if (gumboIds.length === 0) return { teams, players }
  const rows = await db
    .selectFrom('gumbo_ids')
    .select(['gumbo_id', 'user_id'])
    .where('gumbo_id', 'in', gumboIds)
    .execute()
  const survivors = await survivorsOf(
    db,
    rows.map(r => r.user_id)
  )
  const users = new Map(rows.map(r => [r.gumbo_id, survivors.get(r.user_id)!]))
  for (const appearance of appearances) {
    const id = users.get(appearance.gumboId)
    if (id === undefined) continue
    const recent = players.get(id) ?? []
    const teamId = appearance.teamId
    if (
      teamId !== null &&
      names.has(teamId) &&
      recent.length < 2 &&
      !recent.some(t => t.id === teamId)
    )
      recent.push({ id: teamId, name: names.get(teamId)! })
    players.set(id, recent)
  }
  return { teams, players }
}
