/** What of a game `scoringEntry` reads. */
export interface ScoringEntryGame {
  linescore?: unknown
  homeScore?: number | null
  awayScore?: number | null
  status?: string | null
  scoringOwner?: string | null
  replayable?: boolean
}

/** Whether nobody has put a score on the game. */
export function isUnscoredGame(
  game: Pick<ScoringEntryGame, 'linescore' | 'homeScore' | 'awayScore'>
): boolean {
  return (
    game.linescore == null && game.homeScore == null && game.awayScore == null
  )
}

/**
 * How a game may be scored: a game nobody has scored can be scored, a game
 * TeamStation is scoring, and any game whose plays hold the records it
 * replays from — scored here or imported, in progress, or final and open to
 * correction — can be taken up again, and anything else cannot. The Game
 * page offers scoring by it, and the server keeps a phone's games for
 * scoring by it.
 */
export function scoringEntry(
  game: ScoringEntryGame
): 'score' | 'continue' | null {
  if (game.status === 'cancelled') return null
  if (game.scoringOwner === 'teamstation' || game.replayable === true)
    return 'continue'
  if (game.status === 'final') return null
  return isUnscoredGame(game) ? 'score' : null
}
