import { baseIds, battingSide } from '../../common/scoring/rules'
import type { GameState } from '../../common/scoring/state'

/** Current batting slots, most recent completed turn first, including substitutes. */
export function recentRunnerIds(state: GameState): number[] {
  const side = battingSide(state)
  const team = state.liveData.boxscore.teams[side]
  const order = team.battingOrder
  if (order.length === 0) return []
  let start = (team.battingIndex + order.length - 1) % order.length
  const last = state.liveData.plays.allPlays.findLast(
    play =>
      play.about.isComplete &&
      play.about.halfInning === (side === 'away' ? 'top' : 'bottom')
  )
  if (last != null) {
    const id = last.matchup.batter.id
    const slot = order.indexOf(id)
    const previousSlot = last.lineups?.began[side].battingOrder.indexOf(id)
    if (slot >= 0) start = slot
    else if (
      previousSlot != null &&
      previousSlot >= 0 &&
      previousSlot < order.length
    )
      start = previousSlot
  }
  const occupied = baseIds(state)
  const batter = state.liveData.linescore.offense.batter?.id
  return Array.from(
    { length: order.length },
    (_, offset) => order[(start - offset + order.length) % order.length]
  ).filter(id => id !== batter && !occupied.includes(id))
}
