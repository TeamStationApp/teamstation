import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions } from '../../test/scoringHelpers'
import { sampleHit } from '../field/playAnimationModel'
import {
  homeRunKind,
  homeRunLanding,
  OUTFIELD_RADIUS
} from '../field/stadiumBoundary'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import { presentationRuntime, stepPresentation } from './scoringPresentation'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'
function initial(mask: number, animate = false): ScoringState {
  const state = initialScoringState(
    createDevelopmentSession(gameFixture, [], []),
    animate
  )
  for (const [i, base] of (['first', 'second', 'third'] as const).entries())
    if ((mask & (1 << i)) !== 0)
      state.session.liveData.linescore.offense[base] = playerRef(
        state.session,
        i + 2
      )
  return state
}
function homer(state: ScoringState, outside: boolean): ScoringState {
  state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Home Run' })
  state = scoringReducer(state, {
    type: 'LANDING',
    point: { x: 0, z: outside ? -129 : -100 },
    landingHeight: outside ? 7.75 : undefined,
    generation: state.generation
  })
  return scoringReducer(state, {
    type: 'TRAJECTORY',
    angle: 45,
    generation: state.generation
  })
}
describe('home-run landing and automatic arrivals', function () {
  it('uses the visible fence, treats wall hits as in play and clamps landing to stadium bounds', function () {
    expect(homeRunKind({ x: 0, z: -110 })).equals('in-park')
    expect(homeRunKind({ x: 0, z: -OUTFIELD_RADIUS })).equals('in-park')
    expect(homeRunKind({ x: 0, z: -OUTFIELD_RADIUS - 0.1 })).equals(
      'out-of-park'
    )
    expect(homeRunKind({ x: 150, z: 0 })).equals('in-park')
    expect(
      Math.hypot(...Object.values(homeRunLanding({ x: 300, z: -500 })))
    ).closeTo(160, 0.00001)
  })
  for (const animate of [false, true])
    for (const outside of [false, true])
      for (let mask = 0; mask < 8; mask++)
        it(`${outside ? 'stands' : 'in-park'} occupancy ${mask} animation ${animate} scores automatically once`, function () {
          const before = initial(mask, animate)
          let state = homer(before, outside)
          const kind = outside ? 'out-of-park' : 'in-park'
          expect(state.pendingPlay!.homeRunKind).equals(kind)
          expect(state.session.homeQueue).length(0)
          expect(
            state.session.pending!.movements.every(
              m => m.automaticHome === true && m.decision === 'safe'
            )
          ).equals(true)
          const expected =
            1 + [0, 1, 2].filter(i => (mask & (1 << i)) !== 0).length
          if (animate) {
            const sequence = state.presentation!
            state = scoringReducer(state, {
              type: 'PRESENTATION_CONTACT',
              id: sequence.id,
              generation: state.generation
            })
            // Runner completion cannot end the play while the ball is still flying.
            state = completeMotions(state)
            expect(state.phase).not.equals('ready')
            state = scoringReducer(state, {
              type: 'PRESENTATION_DONE',
              id: sequence.id,
              generation: state.generation,
              stage: 'flight'
            })
          }
          state = completeMotions(state)
          expect(state.phase).equals('ready')
          expect(state.correctionWindow).equals(null)
          expect(state.session.homeQueue).length(0)
          expect(state.session.liveData.linescore.teams.away.runs).equals(
            expected
          )
          const play = state.session.liveData.plays.allPlays.at(-1)!
          expect(play.result.eventType).equals('home_run')
          expect(play.result.rbi).equals(expected)
          expect(play.source.gamestation.homeRunKind).equals(kind)
          expect(
            play.runners.filter(r => r.movement.runScored === true)
          ).length(expected)
          expect(
            new Set(play.runners.map(r => r.details.runner.id)).size
          ).equals(expected)
          expect(scoringReducer(state, { type: 'CLOSE_PLAY' })).equals(state)
          const undo = scoringReducer(state, { type: 'UNDO' })
          expect(undo.session.liveData.plays.allPlays).length(0)
          expect(undo.pendingPlay!.homeRunKind).equals(kind)
          expect(undo.session.liveData.linescore.teams.away.runs).equals(0)
        })
  it('keeps a stands flight elevated and defenders in the field without a fictional catch', function () {
    let state = homer(initial(7, true), true)
    const seq = state.presentation!
    if (seq.kind !== 'hit') throw new Error('Expected hit')
    const before = scoringFieldPlayers(state)
    expect(before.every(p => p.motion == null)).equals(true)
    const sample = sampleHit(seq, seq.durationMs)
    expect(sample.ball.y).equals(7.75)
    expect(Math.hypot(sample.fielder.x, sample.fielder.z)).at.most(110.00001)
    expect(
      stepPresentation(presentationRuntime(), seq, seq.durationMs, false).cues
    ).deep.equals(['swish', 'bat'])
    state = scoringReducer(state, {
      type: 'PRESENTATION_CONTACT',
      id: seq.id,
      generation: 0
    })
    state = scoringReducer(state, {
      type: 'PRESENTATION_DONE',
      id: seq.id,
      generation: 0,
      stage: 'flight'
    })
    expect(
      Math.hypot(
        ...Object.values(
          scoringFieldPlayers(state).find(p => p.playerId === 10)!.position
        )
      )
    ).at.most(110.00001)
    state = completeMotions(state)
    expect(state.session.liveData.linescore.teams.away.runs).equals(4)
  })
})
