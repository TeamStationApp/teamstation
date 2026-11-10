import { shortNames } from '../names'
import type { GamePlayer, GameState } from '../scoring/state'

/**
 * Every player's name as a replay's reader reads it, on the box score: a
 * first name and as much of the last as tells two players apart, or the
 * full name of one this reader reads in full.
 */
export function namesOf(state: GameState): Map<number, string> {
  return gamePlayerNames(Object.values(state.gameData.players))
}

/**
 * Every player's name as the public reads it: the card's sentences, which
 * the announcer reads aloud from the server's public record, so a player
 * this reader reads in full is named by the label kept beside his full name
 * (`compactName`, in `compactFormat`).
 */
export function publicNamesOf(state: GameState): Map<number, string> {
  return gamePlayerNames(
    Object.values(state.gameData.players).map(player =>
      player.compactName == null
        ? player
        : {
            ...player,
            fullName: player.compactName,
            nameFormat: player.compactFormat
          }
    )
  )
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
