/**
 * A game's line score at one moment, as the player's box score draws it: one
 * row a side, its runs in each inning so far, then its runs, hits and
 * errors. Worked out from the game's events alone, never from the
 * scoreboard log.
 */
export interface BoardLineSide {
  /**
   * The side's runs in inning `i + 1`, or null for a half that has not
   * started: the home side's half of an inning the visitors are batting in,
   * or the one it never batted because it was ahead.
   */
  innings: Array<number | null>
  r: number
  /** Null when the plays cannot say. */
  h: number | null
  e: number | null
}

export interface BoardLine {
  away: BoardLineSide
  home: BoardLineSide
}
