import { scoringReducer } from '../app/scoring/scoringMachine'
import type { ScoringState } from '../app/scoring/scoringTypes'
export function completeMotions(state: ScoringState): ScoringState {
  for (let count = 0; count < 100; count++) {
    const motion = state.motions.find(motion => !motion.complete)
    if (motion == null) return state
    state = scoringReducer(state, {
      type: 'MOTION_DONE',
      id: motion.id,
      generation: motion.generation
    })
  }
  return state
}
