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
      if (sequence.kind !== 'pitch') throw new Error('Expected pitch')
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
    if (sequence.kind !== 'pitch') throw new Error('Expected pitch')
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

describe('hit presentation coordination', function () {
  for (const [outcome, angle] of [
    ['Single', -5],
    ['Double', 25],
    ['Triple', 50],
    ['Home Run', -45]
  ] as const)
    it(`holds ${outcome} through trajectory, then releases runners at contact`, function () {
      let state = scoringReducer(initial(), { type: 'OUTCOME', outcome })
      const origin = scoringFieldPlayers(state).find(
        p => p.playerId === 10
      )!.position
      state = scoringReducer(state, {
        type: 'FIELDER',
        id: 10,
        point: { x: 25, z: -75 },
        generation: 0
      })
      expect(state.motions).has.length(0)
      expect(state.pendingPlay!.movements).has.length(0)
      state = scoringReducer(state, {
        type: 'TRAJECTORY',
        angle,
        generation: 0
      })
      const seq = state.presentation!
      if (seq.kind !== 'hit') throw new Error('Expected hit')
      expect(seq.fielderStart).deep.equals(origin)
      expect(scoringFieldPlayers(state).every(p => p.motion == null)).equals(
        true
      )
      const clock = presentationRuntime()
      expect(stepPresentation(clock, seq, 449, false).contact).equals(false)
      expect(stepPresentation(clock, seq, 1, false).contact).equals(true)
      const contact = {
        type: 'PRESENTATION_CONTACT' as const,
        id: seq.id,
        generation: seq.generation
      }
      expect(scoringReducer(state, { ...contact, id: 'stale' })).equals(state)
      state = scoringReducer(state, contact)
      expect(scoringReducer(state, contact)).equals(state)
      expect(scoringFieldPlayers(state).some(p => p.motion != null)).equals(
        true
      )
      const flight = state.presentation!
      const frame = stepPresentation(clock, flight, seq.durationMs, false)
      expect(frame.done).equals(true)
      expect(frame.cues).deep.equals(['pop'])
      const done = {
        type: 'PRESENTATION_DONE' as const,
        id: seq.id,
        generation: seq.generation,
        stage: flight.stage
      }
      const undone = scoringReducer(state, { type: 'UNDO' })
      expect(scoringReducer(undone, done)).equals(undone)
      expect(scoringReducer(state, done).presentation).equals(null)
    })
})
