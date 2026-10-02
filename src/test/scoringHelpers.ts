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

export function singleCorrection(state: ScoringState): ScoringState {
  state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Single' })
  state = scoringReducer(state, {
    type: 'FIELDER',
    id: state.session.liveData.linescore.defense.P!.id,
    point: { x: 0, z: -25 },
    generation: state.generation
  })
  return completeMotions(
    scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: 25,
      generation: state.generation
    })
  )
}
