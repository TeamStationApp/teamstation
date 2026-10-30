import { shortNames } from '../names'
import type { GamePlayer, GameState } from '../scoring/state'

/**
 * Every player's name as a replay gives it, on the box score, the card and
 * the announcer alike: a first name and as much of the last as tells two
 * players apart.
 */
export function namesOf(state: GameState): Map<number, string> {
  return gamePlayerNames(Object.values(state.gameData.players))
}

/**
 * Names for a game's players. A label in a chosen format is what the server
 * wrote, collisions included, and is drawn as sent. Everybody else takes the
 * first name and as much of the last as tells them apart.
 */
export function gamePlayerNames(
  players: ReadonlyArray<
    Pick<
      GamePlayer,
      'id' | 'fullName' | 'firstName' | 'lastName' | 'nameFormat'
    >
  >
): Map<number, string> {
  const names = shortNames(
    players
      .filter(player => player.nameFormat == null)
      .map(player => ({
        id: player.id,
        firstName: player.firstName ?? null,
        lastName: player.lastName ?? null,
        displayName: player.fullName
      }))
  )
  return new Map(
    players.map(player => [
      player.id,
      player.nameFormat == null
        ? (names.get(player.id) ?? '')
        : player.fullName.trim()
    ])
  )
}
