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
        const receiving = scoringFieldPlayers(state)
        expect(
          receiving.filter(p => p.receivingBall === true).map(p => p.playerId)
        ).deep.equals([id])
        expect(receiving.some(p => p.hasBall === true)).equals(false)
        expect(
          scoringFieldPlayers(undo).some(p => p.receivingBall === true)
        ).equals(false)
        expect(
          scoringFieldPlayers(cancel).some(p => p.receivingBall === true)
        ).equals(false)
        const flight = state.presentation!
        state = done(state)
        expect(
          scoringFieldPlayers(state).some(p => p.receivingBall === true)
        ).equals(false)
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
        state.session.liveData.plays.currentPlay!.source.teamstation.runnerActions!.at(
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

describe('a relay that forces the lead runner before the batter', function () {
  // Walk the first batter, then the next one grounds to short.
  function grounder(): ScoringState {
    let state = initialScoringState(
      createDevelopmentSession(gameFixture, [], [])
    )
    for (let i = 0; i < 4; i++)
      state = completeMotions(
        scoringReducer(state, { type: 'PITCH', kind: 'ball' })
      )
    state = scoringReducer(state, {
      type: 'CLOSE_PLAY',
      generation: state.generation
    })
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Throw Out' })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 14,
      point: { x: -20, z: -40 },
      generation: state.generation
    })
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: -10,
      generation: state.generation
    })
    return completeMotions(state)
  }
  const drop = (
    state: ScoringState,
    decision: 'safe' | 'out',
    to = 2
  ): ScoringState =>
    scoringReducer(state, {
      type: 'RUNNER_DROP',
      id: 1,
      to,
      decision,
      generation: state.generation
    })

  it('records 6-4-3 as the lead runner out at second, then the batter at first', function () {
    let state = grounder()
    expect(state.phase).equals('chooseDefender')
    expect(state.runnerAction).includes({
      purpose: 'batterRetirement',
      thrower: 14
    })
    state = completeMotions(
      scoringReducer(state, {
        type: 'DEFENDER',
        id: 13,
        point: { ...BASES[2] },
        generation: state.generation
      })
    )
    // Safe, a base too far, or no throw yet: nothing happens.
    expect(drop(state, 'safe')).equals(state)
    expect(drop(state, 'out', 3)).equals(state)
    expect(drop(grounder(), 'out')).not.equals(state)
    const beforeForce = state
    state = drop(state, 'out')
    expect(state.phase).equals('chooseDefender')
    expect(state.session.liveData.linescore.outs).equals(1)
    // Undo takes the force out back and leaves the relay where it was.
    const undone = scoringReducer(state, { type: 'UNDO' })
    expect(undone.session).deep.equals(beforeForce.session)
    expect(undone.runnerAction).deep.equals(beforeForce.runnerAction)
    expect(state.runnerAction).includes({ thrower: 13, playerId: 2 })
    state = completeMotions(
      scoringReducer(state, {
        type: 'DEFENDER',
        id: 12,
        point: { ...BASES[1] },
        generation: state.generation
      })
    )
    state = completeMotions(
      scoringReducer(state, { type: 'DEFENDER', generation: state.generation })
    )
    state = scoringReducer(state, {
      type: 'CLOSE_PLAY',
      generation: state.generation
    })
    const play = state.session.liveData.plays.allPlays.at(-1)!
    expect(play.result.eventType).equals('grounded_into_double_play')
    expect(
      play.runners.map(runner => [
        runner.details.runner.id,
        runner.details.movementReason,
        runner.movement.outNumber,
        runner.movement.forceOut,
        runner.credits.map(credit => `${credit.credit} ${credit.player.id}`)
      ])
    ).deep.equals([
      [1, 'Force Out', 1, true, ['f_assist 14', 'f_putout 13']],
      [2, 'Throw Out', 2, true, ['f_assist 13', 'f_putout 12']]
    ])
    expect(state.log.filter(action => action.type === 'runnerMovement')).length(
      2
    )
  })

  it('ends the half when the force is the third out', function () {
    let state = grounder()
    state = completeMotions(
      scoringReducer(state, {
        type: 'DEFENDER',
        id: 13,
        point: { ...BASES[2] },
        generation: state.generation
      })
    )
    const ended = completeMotions(drop(withTwoOuts(state), 'out'))
    expect(ended.session.liveData.linescore.outs).equals(0)
    expect(ended.session.liveData.linescore.isTopInning).equals(false)
    // The batter was never put out, and the runner was forced: a forceout.
    const play = ended.session.liveData.plays.allPlays.at(-1)!
    expect(play.result.eventType).equals('force_out')
    expect(play.runners.filter(runner => runner.movement.isOut)).length(1)
    expect(ended.runnerAction).equals(null)
  })
})

/** The same moment, with two out before the ball was hit. */
function withTwoOuts(state: ScoringState): ScoringState {
  const next = structuredClone(state)
  next.session.liveData.linescore.outs = 2
  return next
}
