import type { ReplayTimeline } from '../../common/replay/replayTimeline'
import { initialScoringState, scoringReducer } from '../scoring/scoringMachine'
import { halfOf } from './replayMachine'

/**
 * Which of a timeline's steps end a half: the steps after which the game
 * stands in another inning or half than before them, the same comparison the
 * replay makes when it adds the half's pause. A timing scenario counts a
 * pitch's gap as a pitch only when its step does not end a half.
 */
export function stepHalfEnds(timeline: ReplayTimeline): boolean[] {
  let state = initialScoringState(timeline.start, true, { watching: true })
  return timeline.steps.map(step => {
    const before = halfOf(state)
    state = scoringReducer(state, { type: 'REPLAYED', actions: step.actions })
    return halfOf(state) !== before
  })
}
