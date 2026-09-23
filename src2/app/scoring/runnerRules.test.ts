import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  basePath,
  homeBackProposal,
  homeQueuePoint,
  runnerReasons
} from './runnerRules'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { baseIds, playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'
function initial(mask = 0): ScoringState {
  const state = initialScoringState(
    createDevelopmentSession(gameFixture, [], [])
  )
  for (let base = 0; base < 3; base++)
    if ((mask & (1 << base)) !== 0)
      state.session.liveData.linescore.offense[
        (['first', 'second', 'third'] as const)[base]
      ] = playerRef(state.session, base + 2)
  return state
}
function hit(
  state: ScoringState,
  outcome:
    | 'Single'
    | 'Double'
    | 'Triple'
    | 'Home Run'
    | 'Error'
    | "Fielder's Choice" = 'Single'
): ScoringState {
  state = scoringReducer(state, { type: 'OUTCOME', outcome })
  state = scoringReducer(state, {
    type: 'FIELDER',
    id: 10,
    point: { x: 10, z: -40 },
    generation: state.generation
  })
  return scoringReducer(state, {
    type: 'TRAJECTORY',
    angle: 25,
    generation: state.generation
  })
}
function expire(state: ScoringState): ScoringState {
  return scoringReducer(state, {
    type: 'TIMER_TICK',
    elapsedMs: 10000,
    generation: state.generation,
    revision: state.correctionWindow?.revision ?? 0
  })
}
function retire(state: ScoringState, defender = 11): ScoringState {
  state = scoringReducer(state, {
    type: 'THROWER',
    id: 10,
    point: { x: 0, z: -20 },
    generation: state.generation
  })
  state = scoringReducer(state, {
    type: 'DEFENDER',
    id: defender,
    generation: state.generation
  })
  return scoringReducer(state, {
    type: 'DEFENDER',
    generation: state.generation
  })
}
describe('runner progression and correction deadline', function () {
  it('reflows the home queue after an out and lets the unresolved batter adjust a preview', function () {
    let state = completeMotions(hit(initial(7), 'Home Run'))
    state = scoringReducer(state, { type: 'HOME', decision: 'out' })
    state = retire(state)
    expect(state.homeQueue).deep.equals([3, 2])
    expect(
      state.motions.find(motion => motion.playerId === 3)!.waypoints
    ).deep.equals([homeQueuePoint(1), homeQueuePoint(0)])
    state = completeMotions(state)
    expect(state.phase).equals('homeDecision')
    expect(state.homeQueue[0]).equals(3)
    state = hit(initial(), 'Error')
    state = scoringReducer(state, { type: 'RUNNER_PROPOSE', id: 1, to: 0 })
    state = scoringReducer(state, { type: 'RUNNER_PROPOSE', id: 1, to: 1 })
    expect(state.runnerAction!.to).equals(1)
    state = completeMotions(
      scoringReducer(state, { type: 'RUNNER_DECIDE', decision: 'safe' })
    )
    expect(state.phase).equals('correctionWindow')
    expect(baseIds(state.session)).deep.equals([1, null, null])
  })
  for (let mask = 0; mask < 8; mask++)
    for (const [outcome, bases] of [
      ['Single', 1],
      ['Double', 2],
      ['Triple', 3],
      ['Home Run', 4]
    ] as const)
      it(`${outcome} advances occupancy ${mask} with explicit home decisions`, function () {
        const start = initial(mask)
        let state = hit(start, outcome)
        expect(state.session.liveData.linescore.teams.away.runs).equals(0)
        const queue = [3, 2, 1]
          .filter(base => (mask & (1 << (base - 1))) !== 0 && base + bases >= 4)
          .map(base => base + 1)
        expect(state.homeQueue).deep.equals(queue)
        expect(state.correctionWindow).equals(null)
        state = completeMotions(state)
        for (const id of queue) {
          expect(state.homeQueue[0]).equals(id)
          state = scoringReducer(state, { type: 'HOME', decision: 'safe' })
          state = completeMotions(state)
        }
        expect(state.phase).equals(bases === 4 ? 'ready' : 'correctionWindow')
        expect(state.session.liveData.linescore.teams.away.runs).equals(
          queue.length + (bases === 4 ? 1 : 0)
        )
        if (bases !== 4)
          expect(state.correctionWindow!.remainingMs).equals(10000)
        const beforeClose = state
        state = expire(state)
        expect(state.session.liveData.plays.allPlays).has.length(1)
        expect(
          state.session.liveData.plays.currentPlay?.matchup.batter.id
        ).equals(baseIds(beforeClose.session).includes(2) ? undefined : 2)
        expect(
          state.session.liveData.boxscore.teams.home.pitchCounts[10]
        ).equals(1)
        expect(
          scoringReducer(state, {
            type: 'TIMER_TICK',
            elapsedMs: 10000,
            generation: beforeClose.generation,
            revision: beforeClose.correctionWindow?.revision ?? 0
          })
        ).equals(state)
        const undone = scoringReducer(state, { type: 'UNDO' })
        expect(undone.session.liveData.plays.allPlays).has.length(0)
        expect(
          undone.session.liveData.plays.currentPlay?.matchup.batter.id
        ).equals(1)
      })
  it('keeps earlier runs when a runner is tagged out at home for the third out', function () {
    const start = initial(6)
    start.session.liveData.linescore.outs = 2
    let state = completeMotions(hit(start, 'Home Run'))
    state = completeMotions(
      scoringReducer(state, { type: 'HOME', decision: 'safe' })
    )
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    state = scoringReducer(state, { type: 'HOME', decision: 'out' })
    state = completeMotions(retire(state))
    expect(state.session.liveData.linescore.inningState).equals('Bottom')
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    const runners = state.session.liveData.plays.allPlays.at(-1)!.runners
    expect(
      runners.find(move => move.details.runner.id === 4)!.movement.runScored
    ).equals(true)
    expect(
      runners.find(move => move.details.runner.id === 3)!.movement.forceOut
    ).equals(false)
    state = expire(state)
    expect(state.session.liveData.linescore.inningState).equals('Bottom')
    expect(state.session.liveData.plays.allPlays[0].result.awayScore).equals(1)
  })
  it('backs a legal single up atomically and hides Back for forced or fixed-batter collisions', function () {
    let state = completeMotions(hit(initial(6)))
    expect(
      homeBackProposal(state)
        ?.filter(move => move.decision !== 'out')
        .map(move => [move.playerId, move.to])
    ).deep.equals([
      [4, 3],
      [3, 2],
      [1, 1]
    ])
    state = completeMotions(
      scoringReducer(state, { type: 'HOME', decision: 'back' })
    )
    expect(baseIds(state.session)).deep.equals([1, 3, 4])
    expect(state.homeQueue).has.length(0)
    for (const outcome of ['Single', 'Triple', 'Home Run'] as const)
      expect(
        homeBackProposal(completeMotions(hit(initial(7), outcome)))
      ).equals(null)
  })
  it('waits for animations, ignores duplicates, resets edits and guards stale deadlines after Undo', function () {
    let state = hit(initial())
    const first = state.motions[0]
    expect(
      scoringReducer(state, {
        type: 'MOTION_DONE',
        id: first.id,
        generation: 999
      })
    ).equals(state)
    state = completeMotions(state)
    expect(
      scoringReducer(state, {
        type: 'MOTION_DONE',
        id: first.id,
        generation: first.generation
      })
    ).equals(state)
    state = scoringReducer(state, {
      type: 'TIMER_TICK',
      elapsedMs: 7500,
      generation: state.generation,
      revision: state.correctionWindow!.revision
    })
    expect(state.correctionWindow!.remainingMs).equals(2500)
    state = scoringReducer(state, { type: 'RUNNER_PROPOSE', id: 1, to: 2 })
    const paused = state
    expect(expire(state)).equals(paused)
    state = completeMotions(
      scoringReducer(state, { type: 'RUNNER_DECIDE', decision: 'safe' })
    )
    expect(state.correctionWindow!.remainingMs).equals(10000)
    const undone = scoringReducer(state, { type: 'UNDO' })
    expect(undone.generation).greaterThan(state.generation)
    expect(
      scoringReducer(undone, {
        type: 'TIMER_TICK',
        elapsedMs: 10000,
        generation: state.generation,
        revision: state.correctionWindow!.revision
      })
    ).equals(undone)
  })
  it('records assisted and unassisted home outs, voids runs on a force third out and stops the queue', function () {
    let state = initial(7)
    state.session.liveData.linescore.outs = 2
    state = completeMotions(hit(state, 'Home Run'))
    state = completeMotions(
      scoringReducer(state, { type: 'HOME', decision: 'safe' })
    )
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    state = scoringReducer(state, { type: 'HOME', decision: 'out' })
    state = completeMotions(retire(state))
    // This runner was not forced home from second, so the earlier run stands.
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    expect(state.homeQueue).has.length(0)
    expect(state.session.liveData.linescore.inningState).equals('Bottom')
    expect(
      state.session.liveData.plays.allPlays
        .at(-1)!
        .runners.at(-1)!
        .credits.map(credit => credit.credit)
    ).deep.equals(['f_assist', 'f_putout'])
    state = expire(state)
    expect(state.session.liveData.linescore.inningState).equals('Bottom')
    let forced = completeMotions(hit(initial(7)))
    forced.session.liveData.linescore.outs = 2
    forced.session.liveData.linescore.teams.away.runs = 1
    forced = scoringReducer(forced, { type: 'HOME', decision: 'out' })
    forced = completeMotions(retire(forced, 10))
    expect(forced.session.liveData.linescore.teams.away.runs).equals(0)
    expect(
      forced.session.liveData.plays.allPlays
        .at(-1)!
        .runners.at(-1)!
        .credits.map(credit => credit.credit)
    ).deep.equals(['f_putout'])
  })
  it('keeps between-pitch advances on the current appearance with their reasons and count', function () {
    for (const reason of [
      'Steal',
      'Throwing Error',
      'Fielding Error',
      'Defensive Indifference',
      'Other'
    ]) {
      let state = initial(1)
      state = scoringReducer(state, { type: 'PITCH', kind: 'ball' })
      state = scoringReducer(state, { type: 'RUNNER_PROPOSE', id: 2, to: 2 })
      state = scoringReducer(state, { type: 'RUNNER_DECIDE', decision: 'safe' })
      expect(runnerReasons(state)).includes(reason)
      state = completeMotions(
        scoringReducer(state, { type: 'RUNNER_REASON', reason })
      )
      expect(state.phase).equals('ready')
      expect(baseIds(state.session)).deep.equals([null, 2, null])
      expect(state.session.liveData.linescore.balls).equals(1)
      expect(
        state.session.liveData.plays.currentPlay!.matchup.batter.id
      ).equals(1)
      expect(
        state.session.liveData.plays.currentPlay!.playEvents.at(-1)!.details
          .description
      ).equals(reason)
      expect(
        state.session.liveData.plays.currentPlay!.runners.at(-1)!.details
          .movementReason
      ).equals(reason)
    }
  })
  it('supports stationary safe pickoff and every out reason without adding a pitch or skipping the current batter', function () {
    for (const advanced of [false, true])
      for (const reason of advanced
        ? [
            'Caught Stealing',
            'Offensive Interference',
            'Out on Appeal',
            'Other'
          ]
        : ['Picked Off', 'Offensive Interference', 'Out on Appeal', 'Other']) {
        let state = initial(1)
        state.session.liveData.linescore.outs = 2
        state = scoringReducer(state, {
          type: 'RUNNER_PROPOSE',
          id: 2,
          to: advanced ? 2 : 1
        })
        state = scoringReducer(state, {
          type: 'RUNNER_DECIDE',
          decision: 'out'
        })
        state = scoringReducer(state, { type: 'RUNNER_REASON', reason })
        state = completeMotions(retire(state))
        expect(state.session.liveData.linescore.inningState).equals('Bottom')
        expect(state.session.liveData.boxscore.teams.away.battingIndex).equals(
          0
        )
        expect(
          state.session.liveData.plays.allPlays[0].runners[0].details
            .movementReason
        ).equals(reason)
        expect(
          state.session.liveData.plays.allPlays[0].playEvents.every(
            event => !event.isPitch
          )
        ).equals(true)
      }
    let safe = initial(1)
    safe = scoringReducer(safe, { type: 'RUNNER_PROPOSE', id: 2, to: 1 })
    safe = scoringReducer(safe, { type: 'RUNNER_DECIDE', decision: 'safe' })
    expect(safe.phase).equals('ready')
    expect(
      safe.session.liveData.plays.currentPlay!.playEvents.at(-1)!.details
        .description
    ).equals('Safe from Pickoff')
  })
  it('resolves Error and Fielder’s Choice without inventing a batter base or displacing a runner silently', function () {
    for (const outcome of ['Error', "Fielder's Choice"] as const) {
      let state = hit(initial(1), outcome)
      expect(state.phase).equals('resolveBatter')
      state = scoringReducer(state, { type: 'RUNNER_PROPOSE', id: 1, to: 1 })
      state = scoringReducer(state, { type: 'RUNNER_DECIDE', decision: 'safe' })
      expect(state.phase).equals('resolveBatter')
      expect(baseIds(state.session)).deep.equals([2, null, null])
      state = scoringReducer(state, { type: 'RUNNER_PROPOSE', id: 2, to: 2 })
      state = scoringReducer(state, { type: 'RUNNER_DECIDE', decision: 'out' })
      state = completeMotions(retire(state))
      state = completeMotions(state)
      expect(baseIds(state.session)).deep.equals([1, null, null])
      expect(
        state.session.liveData.plays.currentPlay!.runners.find(
          move => move.movement.isOut
        )!.movement.forceOut
      ).equals(true)
      expect(state.phase).equals('correctionWindow')
      expect(state.session.liveData.plays.currentPlay!.result.event).equals(
        outcome
      )
    }
    expect(basePath(0, 4)).has.length(5)
  })
})
