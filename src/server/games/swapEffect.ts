import { systemCancelled } from '../../common/gameApprovals'
import { type SwapEffect, swapEffect } from '../../common/scoring/playsLost'

/**
 * What swapping home and away does to a game (`swapEffect`), from its row as
 * stored and its stored plays' Gumbo: the raw at-bat column, never one a
 * reader folded. Every server path that answers or acts on it uses this.
 */
export function gameSwapEffect(
  game: {
    currentPlay: unknown
    status: string
    cancellation_reason: string | null
  },
  plays: readonly unknown[]
): SwapEffect {
  return swapEffect(
    { plays, currentPlay: game.currentPlay },
    {
      status: game.status,
      withdrawn: systemCancelled(game.cancellation_reason)
    }
  )
}
