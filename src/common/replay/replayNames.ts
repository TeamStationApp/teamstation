import { shortNames } from '../names'
import type { GameState } from '../scoring/state'

/**
 * Every player's name as a replay gives it, on the box score, the card and
 * the announcer alike: a first name and as much of the last as tells two
 * players apart.
 */
export function namesOf(state: GameState): Map<number, string> {
  const names = shortNames(
    Object.values(state.gameData.players).map(player => ({
      id: player.id,
      firstName: player.firstName ?? null,
      lastName: player.lastName ?? null,
      displayName: player.fullName
    }))
  )
  return new Map([...names].map(([id, name]) => [Number(id), name]))
}
