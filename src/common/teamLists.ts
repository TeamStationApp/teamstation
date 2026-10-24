import type { SideTeams } from './scoring/teamRecord'

/**
 * A game's per-team lists — its guests, the players left off its lineups —
 * as they are stored: under each team's id, never under home or away, so
 * they stay with their team when the two are exchanged. Read by side with
 * the game's teams, written back by team. A list stored before lists named
 * teams names sides, and reads as it was.
 */

function object(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** The stored lists by side: each team's under its side, or none. */
export function listsBySide(
  raw: unknown,
  teams: SideTeams
): { away: unknown; home: unknown } {
  if (!object(raw)) return { away: [], home: [] }
  const byTeam = teams.away.id in raw || teams.home.id in raw
  if (!byTeam && ('away' in raw || 'home' in raw))
    return { away: raw.away ?? [], home: raw.home ?? [] }
  return { away: raw[teams.away.id] ?? [], home: raw[teams.home.id] ?? [] }
}

/** Whether stored lists still name sides, as written before they named teams. */
export function keyedBySide(raw: unknown, teams: SideTeams): boolean {
  if (!object(raw)) return false
  const ids = [teams.away.id, teams.home.id]
  return Object.keys(raw).some(
    key => (key === 'away' || key === 'home') && !ids.includes(key)
  )
}

/** Lists by side, as stored: under each side's team's id. */
export function listsByTeam<T>(
  lists: { away: T; home: T },
  teams: SideTeams
): Record<string, T> {
  return { [teams.away.id]: lists.away, [teams.home.id]: lists.home }
}

/** A game row's teams, by side. */
export function teamsOfRow(game: {
  home_team_id: string
  away_team_id: string
}): SideTeams {
  return { away: { id: game.away_team_id }, home: { id: game.home_team_id } }
}
