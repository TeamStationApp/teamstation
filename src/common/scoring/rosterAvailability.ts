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

/** Who a side would field: its roster's players and its guests. */
function fielded(
  roster: readonly ScoringRosterEntry[],
  guests: readonly ScoringRosterEntry[],
  left: readonly number[]
): ScoringRosterEntry[] {
  const players = roster.filter(row => row.isPlayer)
  const rosterIds = new Set(players.map(row => asGumboId(row.gumboId)))
  return [
    ...players.filter(row => !left.includes(asGumboId(row.gumboId))),
    ...guests.filter(row => !rosterIds.has(asGumboId(row.gumboId)))
  ]
}

/**
 * Who both sides of a game would field: somebody on both rosters, as a game
 * made after a roster add, or a merge, can leave them. They play for neither
 * until a coach leaves them out of one side; they cannot be asked to choose
 * when the game is made, and a season must not fail to publish over them.
 */
export function onBothSides(
  rosters: Record<Side, readonly ScoringRosterEntry[]>,
  guests: Record<Side, readonly ScoringRosterEntry[]>,
  unrostered: Unrostered
): Set<number> {
  const ids = (side: Side): number[] =>
    fielded(rosters[side], guests[side], unrostered[side]).map(row =>
      asGumboId(row.gumboId)
    )
  const away = new Set(ids('away'))
  return new Set(ids('home').filter(id => away.has(id)))
}

/** Rebuild live options while preserving the placements of players still available. */
export function reconcileRoster(
  held: GameSetup,
  teams: Record<Side, GameTeam>,
  rosters: Record<Side, readonly ScoringRosterEntry[]>,
  guests: Record<Side, readonly ScoringRosterEntry[]>,
  unrostered: Unrostered
): GameSetup {
  const next = copyState(held)
  const contested = onBothSides(rosters, guests, unrostered)
  for (const side of ['away', 'home'] as const) {
    const rosterIds = new Set(
      rosters[side]
        .filter(row => row.isPlayer)
        .map(row => asGumboId(row.gumboId))
    )
    // Somebody already in the game stays with the team they played for.
    const rows = fielded(rosters[side], guests[side], unrostered[side]).filter(
      row => {
        const id = asGumboId(row.gumboId)
        const prior = next.players[id]
        return prior == null
          ? !contested.has(id)
          : prior.teamId === teams[side].id
      }
    )
    const ids = [...new Set(rows.map(row => asGumboId(row.gumboId)))]
    const available = new Set(ids)
    for (const row of rows) {
      const id = asGumboId(row.gumboId)
      const prior = next.players[id]
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
