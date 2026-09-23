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
    type: 'FIELDER',
    id: 10,
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
  for (const outside of [false, true])
    for (let mask = 0; mask < 8; mask++)
      it(`${outside ? 'stands' : 'in-park'} with occupancy ${mask} scores each runner once`, function () {
        const before = initial(mask)
        let state = homer(before, outside)
        const kind = outside ? 'out-of-park' : 'in-park'
        expect(state.pendingPlay!.homeRunKind).equals(kind)
        expect(
          state.session.liveData.plays.currentPlay!.source.gamestation
            .homeRunKind
        ).equals(kind)
        expect(state.homeQueue.includes(1)).equals(false)
        const expected =
          1 + [0, 1, 2].filter(i => (mask & (1 << i)) !== 0).length
        if (outside) expect(state.homeQueue).has.length(0)
        else expect(state.homeQueue).has.length(expected - 1)
        state = completeMotions(state)
        let decisions = 0
        while (state.phase === 'homeDecision') {
          expect(state.homeQueue[0]).not.equals(1)
          state = completeMotions(
            scoringReducer(state, { type: 'HOME', decision: 'safe' })
          )
          decisions++
        }
        expect(decisions).equals(outside ? 0 : expected - 1)
        expect(state.phase).equals('ready')
        expect(state.correctionWindow).equals(null)
        expect(state.session.liveData.linescore.teams.away.runs).equals(
          expected
        )
        const play = state.session.liveData.plays.allPlays.at(-1)!
        expect(play.result.eventType).equals('home_run')
        expect(play.result.rbi).equals(expected)
        expect(
          play.runners.filter(r => r.movement.runScored === true)
        ).has.length(expected)
        expect(new Set(play.runners.map(r => r.details.runner.id)).size).equals(
          expected
        )
        expect(scoringReducer(state, { type: 'CLOSE_PLAY' })).equals(state)
        const undo = scoringReducer(state, { type: 'UNDO' })
        expect(undo.session.liveData.plays.allPlays).has.length(0)
        expect(undo.pendingPlay!.homeRunKind).equals(kind)
        if (outside || mask === 0)
          expect(undo.session.liveData.linescore.teams.away.runs).equals(0)
      })
  it('walks the automatic batter forward through the queue and releases without a position reset', function () {
    let state = completeMotions(homer(initial(7), false))
    for (let index = 0; index < 3; index++) {
      const before = {
        ...scoringFieldPlayers(state).find(p => p.playerId === 1)!.position
      }
      const checkpoint = state
      state = scoringReducer(state, { type: 'HOME', decision: 'safe' })
      const batter = scoringFieldPlayers(state).find(p => p.playerId === 1)!
      expect(batter.position).deep.equals(before)
      const command = state.motions.find(m => m.playerId === 1)!
      expect(command.complete).equals(false)
      expect(command.waypoints[0]).deep.equals(before)
      expect(
        Math.hypot(command.waypoints[1].x, command.waypoints[1].z)
      ).lessThan(Math.hypot(before.x, before.z))
      const undo = scoringReducer(state, { type: 'UNDO' })
      expect(undo.homeQueue).deep.equals(checkpoint.homeQueue)
      expect(
        scoringFieldPlayers(undo).find(p => p.playerId === 1)!.position
      ).deep.equals(before)
      state = completeMotions(state)
    }
    expect(state.phase).equals('ready')
    expect(state.session.liveData.linescore.teams.away.runs).equals(4)
  })
  it('finishes an in-flight approach before release when home decisions are made early', function () {
    let state = homer(initial(7), false)
    const approach = state.motions.find(m => m.playerId === 1)!
    for (let index = 0; index < 3; index++) {
      const lead = state.motions.find(m => m.playerId === state.homeQueue[0])!
      state = scoringReducer(state, {
        type: 'MOTION_DONE',
        id: lead.id,
        generation: lead.generation
      })
      state = scoringReducer(state, { type: 'HOME', decision: 'safe' })
      expect(state.motions.find(m => m.playerId === 1)!.id).equals(approach.id)
    }
    state = scoringReducer(state, {
      type: 'MOTION_DONE',
      id: approach.id,
      generation: approach.generation
    })
    const released = state.motions.find(m => m.playerId === 1)!
    expect(released.id).not.equals(approach.id)
    expect(released.waypoints[0]).deep.equals(approach.waypoints.at(-1))
    state = completeMotions(state)
    expect(state.phase).equals('ready')
    expect(state.session.liveData.linescore.teams.away.runs).equals(4)
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
  it('holds the automatic batter behind decisions and awards no late run after a third out', function () {
    const start = initial(6)
    start.session.liveData.linescore.outs = 2
    let state = completeMotions(homer(start, false))
    expect(
      scoringFieldPlayers(state).find(p => p.playerId === 1)!.runnerBase
    ).equals(4)
    expect(state.session.liveData.linescore.teams.away.runs).equals(0)
    state = completeMotions(
      scoringReducer(state, { type: 'HOME', decision: 'safe' })
    )
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    state = scoringReducer(state, { type: 'HOME', decision: 'out' })
    state = completeMotions(
      scoringReducer(state, { type: 'DEFENDER', generation: 0 })
    )
    expect(state.session.liveData.linescore.inningState).equals('Bottom')
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    expect(
      state.session.liveData.plays.allPlays[0].runners.some(
        r => r.details.runner.id === 1 && r.movement.runScored === true
      )
    ).equals(false)
  })
})
