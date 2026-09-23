import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions } from '../../test/scoringHelpers'
import { BASES } from '../field/fieldModel'
import { sampleThrow } from '../field/playAnimationModel'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'
function done(state: ScoringState): ScoringState {
  const p = state.presentation!
  return scoringReducer(state, {
    type: 'PRESENTATION_DONE',
    id: p.id,
    generation: state.generation,
    stage: p.stage
  })
}
function hit(): ScoringState {
  let state = initialScoringState(
    createDevelopmentSession(gameFixture, [], []),
    true
  )
  state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Single' })
  state = scoringReducer(state, {
    type: 'FIELDER',
    id: 10,
    point: { x: 10, z: -50 },
    generation: 0
  })
  state = scoringReducer(state, {
    type: 'TRAJECTORY',
    angle: 25,
    generation: 0
  })
  const p = state.presentation!
  state = scoringReducer(state, {
    type: 'PRESENTATION_CONTACT',
    id: p.id,
    generation: 0
  })
  state = done(state)
  return completeMotions(state)
}
describe('defensive relay draft', function () {
  for (const receivers of [[], [12], [12, 13, 10]])
    it(`completes ${receivers.length} transfers with possession and one final out`, function () {
      let state = hit()
      const before = state
      state = scoringReducer(state, {
        type: 'RUNNER_DROP',
        id: 1,
        to: 2,
        decision: 'out',
        generation: 0
      })
      expect(state.phase).equals('chooseDefender')
      expect(state.runnerAction!.thrower).equals(10)
      let holder = 10
      for (const id of receivers) {
        const players = scoringFieldPlayers(state)
        expect(
          players.filter(p => p.hasBall === true).map(p => p.playerId)
        ).deep.equals([holder])
        expect(
          scoringReducer(state, { type: 'DEFENDER', id: holder, generation: 0 })
        ).equals(state)
        const old = state
        state = scoringReducer(state, {
          type: 'DEFENDER',
          id,
          point: { x: id, z: -30 },
          generation: 0
        })
        expect(state.session.liveData.linescore.outs).equals(0)
        expect(
          scoringReducer(state, { type: 'DEFENDER', generation: 0 })
        ).equals(state)
        const cancel = scoringReducer(state, { type: 'RUNNER_CANCEL' })
        expect(cancel.session).deep.equals(before.session)
        const undo = scoringReducer(state, { type: 'UNDO' })
        expect(undo.runnerAction!.defensiveRoute).deep.equals(
          old.runnerAction!.defensiveRoute
        )
        const flight = state.presentation!
        state = done(state)
        expect(
          scoringReducer(state, {
            type: 'PRESENTATION_DONE',
            id: flight.id,
            generation: 0,
            stage: flight.stage
          })
        ).equals(state)
        expect(state.session.liveData.linescore.outs).equals(0)
        holder = id
      }
      expect(state.runnerAction!.defensiveRoute!.map(h => h.id)).deep.equals([
        10,
        ...receivers
      ])
      state = scoringReducer(state, {
        type: 'DEFENDER',
        generation: 0,
        runnerPoint: BASES[1]
      })
      const tag = state.presentation!
      if (tag.kind !== 'throw') throw new Error('Expected tag')
      expect(tag.stage).equals('tag')
      expect(tag.runnerFrom).deep.equals(BASES[1])
      expect(tag.to.x).equals(BASES[2].x)
      expect(sampleThrow(tag, tag.durationMs).progress).equals(1)
      state = done(state)
      expect(state.session.liveData.linescore.outs).equals(1)
      const record =
        state.session.liveData.plays.currentPlay!.source.gamestation.runnerActions!.at(
          -1
        )!
      expect(record.defensiveRoute!.map(h => h.player.id)).deep.equals([
        10,
        ...receivers
      ])
      expect(
        record.credits
          .filter(c => c.credit === 'f_putout')
          .map(c => c.player.id)
      ).deep.equals([holder])
      expect(
        new Set(record.credits.map(c => `${c.player.id}:${c.credit}`)).size
      ).equals(record.credits.length)
      expect(
        state.session.liveData.plays.currentPlay!.playEvents.filter(
          e => e.isPitch
        )
      ).has.length(1)
      expect(
        state.motions.find(m => m.playerId === 1)!.waypoints[0]
      ).deep.equals(BASES[2])
      state = completeMotions(state)
      expect(scoringReducer(state, { type: 'UNDO' }).session).deep.equals(
        before.session
      )
    })
  it('asks for a thrower when an out has no known batted-ball holder', function () {
    let state = initialScoringState(
      createDevelopmentSession(gameFixture, [], []),
      true
    )
    state.session.liveData.linescore.offense.first = playerRef(state.session, 2)
    state = scoringReducer(state, {
      type: 'RUNNER_DROP',
      id: 2,
      to: 1,
      decision: 'out',
      generation: 0
    })
    state = scoringReducer(state, {
      type: 'RUNNER_REASON',
      reason: 'Picked Off'
    })
    expect(state.phase).equals('chooseThrower')
    state = scoringReducer(state, {
      type: 'THROWER',
      id: 10,
      point: { x: 0, z: -18 },
      generation: 0
    })
    expect(state.phase).equals('chooseDefender')
  })
})
