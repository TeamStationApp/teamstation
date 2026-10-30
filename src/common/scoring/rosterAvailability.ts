import type { RosterEntry } from '../api'
import type { Unrostered } from '../unroster'
import { asGumboId } from '../userId'
import {
  copyState,
  type GameSetup,
  type GameTeam,
  POSITIONS,
  type Side
} from './state'

export type ScoringRosterEntry = Pick<
  RosterEntry,
  | 'gumboId'
  | 'isPlayer'
  | 'shortName'
  | 'nameFormat'
  | 'jersey'
  | 'positions'
  | 'bats'
  | 'throws'
>

/** Rebuild live options while preserving the placements of players still available. */
export function reconcileRoster(
  held: GameSetup,
  teams: Record<Side, GameTeam>,
  rosters: Record<Side, readonly ScoringRosterEntry[]>,
  guests: Record<Side, readonly ScoringRosterEntry[]>,
  unrostered: Unrostered
): GameSetup {
  const next = copyState(held)
  for (const side of ['away', 'home'] as const) {
    const roster = rosters[side].filter(row => row.isPlayer)
    const rosterIds = new Set(roster.map(row => asGumboId(row.gumboId)))
    const rows = [
      ...roster.filter(
        row => !unrostered[side].includes(asGumboId(row.gumboId))
      ),
      ...guests[side].filter(row => !rosterIds.has(asGumboId(row.gumboId)))
    ]
    const ids = [...new Set(rows.map(row => asGumboId(row.gumboId)))]
    const available = new Set(ids)
    for (const row of rows) {
      const id = asGumboId(row.gumboId)
      const prior = next.players[id]
      if (prior != null && prior.teamId !== teams[side].id)
        throw new Error('A player cannot be available for both teams')
      next.players[id] =
        prior == null
          ? {
              id,
              teamId: teams[side].id,
              fullName: row.shortName,
              ...(row.nameFormat == null ? {} : { nameFormat: row.nameFormat }),
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
    // Account merges can make distinct historical turns share one identity.
    // Availability removes people; it must not collapse their saved placements.
    team.battingOrder = team.battingOrder.filter(id => available.has(id))
    team.battingIndex =
      team.battingOrder.length === 0
        ? 0
        : beforeDue.length % team.battingOrder.length
    for (const position of POSITIONS) {
      const id = team.defense[position]
      if (id == null || !available.has(id)) team.defense[position] = null
    }
  }
  return next
}
