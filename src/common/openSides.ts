import { asString, type Cleaner } from 'cleaners'

import type { Side } from './scoring/state'

/**
 * A game's side may be open: its team is not known yet. The server stores an
 * open side as a null team id; every answer names it TBD and gives it the id
 * `''`, so an app that reads a side's id as a string still reads the game.
 */
export const OPEN_SIDE_NAME = 'TBD'

/** A side's team id as answers give it: `''` for an open side. */
export const wireSideId = (id: string | null): string => id ?? ''

/** A side's team id as answers give it, with `''` read as an open side. */
export const asSideTeamId: Cleaner<string | null> = raw => {
  const id = asString(raw)
  return id === '' ? null : id
}

/** The named teams among a game's sides, for every list of a game's teams. */
export const namedTeamIds = (...ids: Array<string | null>): string[] =>
  ids.filter((id): id is string => id != null)

/** The sides of a game whose team is not known yet, home first. */
export const openSidesOf = (game: {
  homeTeamId: string | null
  awayTeamId: string | null
}): Side[] => {
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
