import type { RosterEntry } from '../api'
import type { Unrostered } from '../unroster'
import {
  copyState,
  type GameSetup,
  type GameTeam,
  POSITIONS,
  type Side
} from './state'

/** Rebuild live options while preserving the placements of players still available. */
export function reconcileRoster(
  held: GameSetup,
  teams: Record<Side, GameTeam>,
  rosters: Record<Side, readonly RosterEntry[]>,
  guests: Record<Side, readonly RosterEntry[]>,
  unrostered: Unrostered
): GameSetup {
  const next = copyState(held)
  for (const side of ['away', 'home'] as const) {
    const roster = rosters[side].filter(row => row.isPlayer)
    const rosterIds = new Set(roster.map(row => row.userId))
    const rows = [
      ...roster.filter(row => !unrostered[side].includes(row.userId)),
      ...guests[side].filter(row => !rosterIds.has(row.userId))
    ]
    const ids = [...new Set(rows.map(row => row.userId))]
    const available = new Set(ids)
    for (const row of rows) {
      const id = row.userId
      const prior = next.players[id]
      if (prior != null && prior.teamId !== teams[side].id)
        throw new Error('A player cannot be available for both teams')
      next.players[id] =
        prior == null
          ? {
              id,
              userId: id,
              teamId: teams[side].id,
              fullName: row.shortName,
              jersey: row.jersey ?? '',
              bats: row.bats ?? 'right',
              throws: row.throws,
              positions: [...row.positions],
              local: !rosterIds.has(id)
            }
          : { ...prior, local: !rosterIds.has(id) }
      if (!next.tagOrder.includes(id)) next.tagOrder.push(id)
    }
    const team = next.sides[side]
    team.players = [
      ...team.players.filter(id => available.has(id)),
      ...ids.filter(id => !team.players.includes(id))
    ]
    team.players = [...new Set(team.players)]
    const beforeDue = team.battingOrder
      .slice(0, team.battingIndex)
      .filter(id => available.has(id))
    team.battingOrder = [
      ...new Set(team.battingOrder.filter(id => available.has(id)))
    ]
    team.battingIndex =
      team.battingOrder.length === 0
        ? 0
        : new Set(beforeDue).size % team.battingOrder.length
    const fielding = new Set<number>()
    for (const position of POSITIONS) {
      const id = team.defense[position]
      if (id == null || !available.has(id) || fielding.has(id))
        team.defense[position] = null
      else fielding.add(id)
    }
  }
  return next
}
