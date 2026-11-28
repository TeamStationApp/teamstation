import { asString, type Cleaner } from 'cleaners'

import type { Side } from './scoring/state'

/**
 * A game's side may be open: its team is not known yet. The server stores an
 * open side as a null team id; every answer names it TBD and gives it the id
 * `''`, so an app that reads a side's id as a string still reads the game.
 */
export const OPEN_SIDE_NAME = 'TBD'

/** A game's ids, either side possibly open. */
interface GameSides {
  homeTeamId: string | null
  awayTeamId: string | null
}

/** A side's team id as answers give it: `''` for an open side. */
export const wireSideId = (id: string | null): string => id ?? ''

/** A side's team id as answers give it, with `''` read as an open side. */
export const asSideTeamId: Cleaner<string | null> = raw => {
  const id = asString(raw)
  return id === '' ? null : id
}

/**
 * A side's team id in an answer kept as it came (a stored document): the id
 * of a named team, or undefined for an open side (`''`) or none.
 */
export const storedSideId = (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw !== '' ? raw : undefined

/** The named teams among a game's sides, for every list of a game's teams. */
export const namedTeamIds = (...ids: Array<string | null>): string[] =>
  ids.filter((id): id is string => id != null)

/** The sides of a game whose team is not known yet, home first. */
export const openSidesOf = (game: GameSides): Side[] => {
  const sides: Side[] = []
  if (game.homeTeamId == null) sides.push('home')
  if (game.awayTeamId == null) sides.push('away')
  return sides
}

/**
 * A side's team name from names read by id: TBD for an open side, and
 * `unknown` for a team whose name was not read.
 */
export const sideName = (
  names: Readonly<Record<string, string>>,
  teamId: string | null,
  unknown: string
): string => (teamId == null ? OPEN_SIDE_NAME : (names[teamId] ?? unknown))

/** A game whose two sides are both named. */
export type NamedSides<T extends GameSides> = T & {
  homeTeamId: string
  awayTeamId: string
}

/** Whether both of a game's sides are named, narrowing its ids to strings. */
export const hasNamedSides = <T extends GameSides>(
  game: T
): game is NamedSides<T> => game.homeTeamId != null && game.awayTeamId != null

/** The game, its sides both named; a game with an open side throws. */
export function withNamedSides<T extends GameSides>(game: T): NamedSides<T> {
  if (!hasNamedSides(game)) throw new Error("This game's team is TBD")
  return game
}
