import { createDevelopmentSession } from '../app/scoring/developmentSession'
import { asRosterEntry, type GameDetail, type RosterEntry } from '../common/api'
import type { GameState } from '../common/scoring/state'

/** Explicit persisted identities for a complete synthetic game. */
export function scoringRoster(firstId: number): RosterEntry[] {
  return Array.from({ length: 9 }, (_, index) =>
    asRosterEntry({
      userId: firstId + index,
      gumboId: firstId + index,
      shortName: `Player ${index + 1}`,
      jersey: String(index + 1),
      positions: [],
      isPlayer: true,
      role: 'player',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
    })
  )
}

/** A full guest lineup for tests whose subject is scoring an already set up game. */
export function scoringSession(game: GameDetail): GameState {
  const state = createDevelopmentSession(
    game,
    scoringRoster(1),
    scoringRoster(10)
  )
  for (const player of Object.values(state.gameData.players))
    player.local = true
  return state
}
