import type { GameDetail } from '../../common/api'

export function isUnscoredGame(
  game: Pick<GameDetail, 'linescore' | 'homeScore' | 'awayScore'>
): boolean {
  return (
    game.linescore == null && game.homeScore == null && game.awayScore == null
  )
}
