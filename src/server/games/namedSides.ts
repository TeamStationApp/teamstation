import { conflict } from '../../common/errors'

/** A game row's sides; a null side is open, its team not known yet. */
export interface GameSideIds {
  home_team_id: string | null
  away_team_id: string | null
}

/** A game row whose sides both name a team. */
export type NamedSides<T extends GameSideIds> = T & {
  home_team_id: string
  away_team_id: string
}

/** The refusal of a scoring write that meets a side whose team is not known. */
export const OPEN_SIDE_UNSCORED =
  "This game's team is TBD. Choose its team before scoring it."

/** Whether both of a game's sides name a team. */
export function hasNamedSides<T extends GameSideIds>(
  game: T
): game is NamedSides<T> {
  return game.home_team_id != null && game.away_team_id != null
}

/**
 * The game, once both its sides name a team. Scoring, its lineups, guests
 * and swaps run only on such a game: one with an open side is refused
 * (409) rather than scored against a team it does not have.
 */
export function requireNamedSides<T extends GameSideIds>(
  game: T
): NamedSides<T> {
  if (!hasNamedSides(game)) throw conflict(OPEN_SIDE_UNSCORED)
  return game
}
