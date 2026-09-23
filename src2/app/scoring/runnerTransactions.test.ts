import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'
function initial(): ScoringState {
  const state = initialScoringState(
    createDevelopmentSession(gameFixture, [], [])
  )
  state.session.liveData.linescore.offense.first = playerRef(state.session, 2)
  return scoringReducer(state, { type: 'PITCH', kind: 'ball' })
}
function drop(state: ScoringState, decision: 'safe' | 'out'): ScoringState {
  return scoringReducer(state, {
    type: 'RUNNER_DROP',
    id: 2,
    to: 2,
    decision,
    generation: state.generation
  })
}
describe('atomic runner drafts', function () {
  for (const decision of ['safe', 'out'] as const)
    it(`cancels ${decision} without canonical changes, then commits one undo action`, function () {
      const before = initial()
      let draft = drop(before, decision)
      expect(draft.phase).equals('runnerReason')
      expect(draft.session).deep.equals(before.session)
      expect(draft.past).deep.equals(before.past)
      const cancel = scoringReducer(draft, { type: 'RUNNER_CANCEL' })
      expect(cancel.phase).equals('ready')
      expect(cancel.runnerAction).equals(null)
      expect(cancel.session).deep.equals(before.session)
      expect(cancel.past).deep.equals(before.past)
      expect(scoringReducer(cancel, { type: 'RUNNER_CANCEL' })).equals(cancel)
      expect(scoringReducer(draft, { type: 'UNDO' })).deep.equals(cancel)
      expect(
        scoringReducer(cancel, { type: 'UNDO' }).session.liveData.linescore
          .balls
      ).equals(0)
      draft = scoringReducer(drop(cancel, decision), {
        type: 'RUNNER_REASON',
        reason: decision === 'safe' ? 'Steal' : 'Caught Stealing'
      })
      if (decision === 'out') {
        expect(draft.session).deep.equals(before.session)
        draft = scoringReducer(draft, {
          type: 'THROWER',
          id: 10,
          point: { x: 0, z: -18 },
          generation: draft.generation
        })
        expect(draft.past).has.length(before.past.length)
        draft = scoringReducer(draft, {
          type: 'DEFENDER',
          id: 11,
          point: { x: 0, z: -38 },
          generation: draft.generation
        })
        draft = scoringReducer(draft, {
          type: 'DEFENDER',
          generation: draft.generation
        })
      }
      expect(draft.past).has.length(before.past.length + 1)
      draft = completeMotions(draft)
      const restored = scoringReducer(draft, { type: 'UNDO' })
      expect(restored.phase).equals('ready')
      expect(restored.runnerAction).equals(null)
      expect(restored.session).deep.equals(before.session)
    })
  it('restores paused timer on cancellation, guards Done during a grab, and resets only accepted edits', function () {
    let state = initialScoringState(
      createDevelopmentSession(gameFixture, [], [])
    )
    for (let i = 0; i < 4; i++)
      state = scoringReducer(state, { type: 'PITCH', kind: 'ball' })
    state = completeMotions(state)
    state = scoringReducer(state, {
      type: 'TIMER_TICK',
      generation: state.generation,
      revision: state.correctionWindow!.revision,
      elapsedMs: 3850
    })
    const grabbed = scoringReducer(state, { type: 'GESTURE', active: true })
    expect(scoringReducer(grabbed, { type: 'CLOSE_PLAY' })).equals(grabbed)
    expect(
      scoringReducer(grabbed, {
        type: 'TIMER_TICK',
        generation: grabbed.generation,
        revision: grabbed.correctionWindow!.revision,
        elapsedMs: 10000
      })
    ).equals(grabbed)
    const draft = scoringReducer(grabbed, {
      type: 'RUNNER_DROP',
      id: 1,
      to: 2,
      decision: 'out',
      generation: state.generation
    })
    const restored = scoringReducer(draft, { type: 'RUNNER_CANCEL' })
    expect(restored.phase).equals('correctionWindow')
    expect(restored.correctionWindow!.remainingMs).equals(6150)
    expect(restored.activeGesture).equals(false)
    expect(restored.past).deep.equals(state.past)
    const moved = completeMotions(
      scoringReducer(restored, {
        type: 'RUNNER_DROP',
        id: 1,
        to: 2,
        decision: 'safe',
        generation: restored.generation
      })
    )
    expect(moved.correctionWindow!.remainingMs).equals(10000)
  })
})
