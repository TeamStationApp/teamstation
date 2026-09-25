import type { GameDetail } from '../../common/api'

export function isUnscoredGame(
  game: Pick<GameDetail, 'linescore' | 'homeScore' | 'awayScore'>
): boolean {
  return (
    game.linescore == null && game.homeScore == null && game.awayScore == null
  )
}

/**
 * How the Game page offers scoring: a game nobody has scored can be scored, a
 * game GameStation is scoring — in progress, or final and open to correction —
 * can be taken up again, and anything else cannot.
 */
export function scoringEntry(
  game: Pick<
    GameDetail,
    'linescore' | 'homeScore' | 'awayScore' | 'status' | 'scoringOwner'
  >
): 'score' | 'continue' | null {
  if (game.status === 'cancelled') return null
  if (game.scoringOwner === 'gamestation') return 'continue'
  if (game.status === 'final') return null
  return isUnscoredGame(game) ? 'score' : null
}
