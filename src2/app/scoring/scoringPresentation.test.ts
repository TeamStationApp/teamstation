import { expect } from 'chai'
import { describe, it } from 'mocha'

import { foulPoint, samplePitch } from '../field/playAnimationModel'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import {
  pitchPresentation,
  presentationRuntime,
  stepPresentation
} from './scoringPresentation'
import type { ScoringState } from './scoringTypes'
function initial(): ScoringState {
  return initialScoringState(
    createDevelopmentSession(gameFixture, [], []),
    true
  )
}
describe('pitch presentation coordination', function () {
  for (const kind of ['ball', 'called', 'swing', 'foul'] as const)
    it(`presents ${kind} once and rejects duplicate or stale completion`, function () {
      const before = initial()
      const state = scoringReducer(before, { type: 'PITCH', kind })
      const sequence = state.presentation!
      expect(sequence.pitch).equals(kind)
      expect(scoringReducer(state, { type: 'PITCH', kind })).equals(state)
      const runtime = presentationRuntime()
      expect(stepPresentation(runtime, sequence, 300, true).cues).has.length(0)
      expect(runtime.elapsedMs).equals(0)
      expect(stepPresentation(runtime, sequence, 0, false).done).equals(false)
      expect(stepPresentation(runtime, sequence, 300, false).cues).deep.equals([
        'swish'
      ])
      const atRelease = samplePitch(sequence, 300)
      expect(atRelease.visible).equals(true)
      expect(atRelease.ball).deep.equals(sequence.from)
      const atPlate = samplePitch(sequence, 700)
      expect(atPlate.ball).deep.equals(sequence.plate)
      expect(atPlate.swing > 0).equals(kind === 'swing' || kind === 'foul')
      const rest = stepPresentation(runtime, sequence, 2000, false)
      expect(rest.cues).deep.equals(kind === 'foul' ? ['pop', 'bat'] : ['pop'])
      expect(rest.done).equals(true)
      expect(stepPresentation(runtime, sequence, 1000, false).cues).has.length(
        0
      )
      expect(samplePitch(sequence, sequence.durationMs).visible).equals(false)
      const done = {
        type: 'PRESENTATION_DONE' as const,
        id: sequence.id,
        generation: sequence.generation,
        stage: sequence.stage
      }
      expect(scoringReducer(state, { ...done, id: 'old' })).equals(state)
      expect(scoringReducer(state, { ...done, generation: 10 })).equals(state)
      const settled = scoringReducer(state, done)
      expect(settled.presentation).equals(null)
      expect(settled.past).has.length(1)
      expect(scoringReducer(settled, done)).equals(settled)
      const undone = scoringReducer(state, { type: 'UNDO' })
      expect(undone.presentation).equals(null)
      expect(undone.session).deep.equals(before.session)
      expect(scoringReducer(undone, done)).equals(undone)
    })
  it('keeps the fourth-ball hitter and runners in their original places until delivery finishes', function () {
    const before = initial()
    before.session.liveData.linescore.balls = 3
    const state = scoringReducer(before, { type: 'PITCH', kind: 'ball' })
    expect(state.motions.some(m => !m.complete)).equals(true)
    const players = scoringFieldPlayers(state)
    expect(players.find(p => p.playerId === 1)?.batting).equals(true)
    expect(players.every(p => p.motion == null)).equals(true)
    const sequence = state.presentation!
    const after = scoringReducer(state, {
      type: 'PRESENTATION_DONE',
      id: sequence.id,
      generation: sequence.generation,
      stage: sequence.stage
    })
    expect(scoringFieldPlayers(after).some(p => p.motion != null)).equals(true)
  })
  it('mirrors a behind-plate 45 degree foul using the actual batter and throwing sides', function () {
    const state = initial()
    state.session.gameData.players[10].throws = 'left'
    state.session.liveData.plays.currentPlay!.matchup.batSide.code = 'L'
    const sequence = pitchPresentation(state, 'foul')
    expect(sequence.throwSide).equals('L')
    expect(sequence.from.x).lessThan(0)
    const right = foulPoint(sequence.plate, 'R', 0.1)
    const left = foulPoint(sequence.plate, 'L', 0.1)
    expect(right.x).greaterThan(0)
    expect(left.x).equals(-right.x)
    expect(left.z).equals(right.z)
    expect(right.z).greaterThan(0)
    const angle =
      (Math.atan2(right.y - sequence.plate.y, Math.hypot(right.x, right.z)) *
        180) /
      Math.PI
    expect(angle).within(44, 46)
    expect(samplePitch(sequence, 1300).opacity).equals(0.5)
    expect(samplePitch(sequence, 0).visible).equals(false)
    const caught = samplePitch(pitchPresentation(state, 'called'), 900)
    expect(caught.catch).greaterThan(0)
  })
})
