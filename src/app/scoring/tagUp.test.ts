import { expect } from 'chai'
import { describe, it } from 'mocha'

import { documentOf } from '../../common/scoring/document'
import {
  CAUGHT_BALL_RETURN_OUT_REASONS,
  DID_NOT_TAG_UP,
  STATIONARY_OUT_REASONS
} from '../../common/scoring/rules'
import { type GamePlay, setupOf } from '../../common/scoring/state'
import { completeMotions, singleCorrection } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from './isUnscoredGame.test'
import { runnerReasons } from './scoringFlow'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { baseIds, playerRef } from './scoringSelectors'
import { CORRECTION_WINDOW_MS, type ScoringState } from './scoringTypes'

/**
 * Runners on first, second and third as the mask says: players 2, 3 and 4,
 * or 7, 8 and 9 when the next batter (2) must be free to come up.
 */
function initial(mask = 1, outs = 0, first = 2): ScoringState {
  const state = initialScoringState(scoringSession(gameFixture))
  for (let base = 0; base < 3; base++)
    if ((mask & (1 << base)) !== 0)
      state.session.liveData.linescore.offense[
        (['first', 'second', 'third'] as const)[base]
      ] = playerRef(state.session, base + first)
  state.session.liveData.linescore.outs = outs
  return state
}
function defense(
  state: ScoringState,
  position: 'C' | 'CF' | '1B' | '2B'
): number {
  return state.session.liveData.linescore.defense[position]!.id
}
/** A ball caught by `fielder` at `point`: deep center by default, fair. */
function caught(
  state: ScoringState,
  fielder: 'C' | 'CF' = 'CF',
  point = { x: 0, z: -90 },
  angle = 30
): ScoringState {
  state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Ball Caught' })
  state = scoringReducer(state, {
    type: 'FIELDER',
    id: defense(state, fielder),
    point,
    generation: state.generation
  })
  return completeMotions(
    scoringReducer(state, {
      type: 'TRAJECTORY',
      angle,
      generation: state.generation
    })
  )
}
function drop(
  state: ScoringState,
  id: number,
  to: number,
  decision: 'safe' | 'out' = 'out'
): ScoringState {
  return completeMotions(
    scoringReducer(state, {
      type: 'RUNNER_DROP',
      id,
      to,
      decision,
      generation: state.generation
    })
  )
}
/** The throw to `receiver` puts the runner out. */
function tag(state: ScoringState, receiver: '1B' | '2B' = '1B'): ScoringState {
  state = scoringReducer(state, {
    type: 'DEFENDER',
    id: defense(state, receiver),
    generation: state.generation
  })
  return completeMotions(
    scoringReducer(state, { type: 'DEFENDER', generation: state.generation })
  )
}
function expire(state: ScoringState): ScoringState {
  return scoringReducer(state, {
    type: 'TIMER_TICK',
    elapsedMs: CORRECTION_WINDOW_MS,
    generation: state.generation,
    revision: state.correctionWindow?.revision ?? 0
  })
}
/** The runner's out on the caught play, open or closed. */
function runnerOut(
  state: ScoringState,
  id: number
): GamePlay['runners'][number] {
  const { currentPlay, allPlays } = state.session.liveData.plays
  const play =
    currentPlay?.runners.some(runner => runner.details.runner.id === id) ===
    true
      ? currentPlay
      : allPlays.at(-1)!
  return play.runners.find(
    runner => runner.details.runner.id === id && runner.movement.isOut
  )!
}

describe('a runner who did not tag up on a caught ball', function () {
  it('is asked why when put out back at his base during the play', function () {
    const state = drop(caught(initial()), 2, 1)
    expect(state.phase).equals('runnerReason')
    expect(state.runnerAction).deep.include({
      playerId: 2,
      from: 1,
      to: 1,
      origin: 'current',
      decision: 'out'
    })
    expect(runnerReasons(state)).deep.equals([
      'Did Not Tag Up',
      'Offensive Interference',
      'Out on Appeal',
      'Other'
    ])
  })

  it('is doubled off on the catch, which closes as a double play', function () {
    const start = initial()
    let state = drop(caught(start), 2, 1)
    state = scoringReducer(state, {
      type: 'RUNNER_REASON',
      reason: DID_NOT_TAG_UP
    })
    expect(state.phase).equals('chooseDefender')
    expect(state.runnerAction).deep.include({
      reason: DID_NOT_TAG_UP,
      thrower: defense(state, 'CF')
    })
    state = tag(state)
    // Nobody is left on base to correct, so the play closes at once.
    expect(state.phase).equals('ready')
    expect(state.session.liveData.linescore.outs).equals(2)
    expect(baseIds(state.session)).deep.equals([null, null, null])
    expect(runnerOut(state, 2).details.movementReason).equals('Ball Caught')
    expect(
      runnerOut(state, 2).credits.map(credit => [
        credit.player.id,
        credit.credit
      ])
    ).deep.equals([
      [defense(state, 'CF'), 'f_assist'],
      [defense(state, '1B'), 'f_putout']
    ])
    expect(state.past.at(-1)?.label).equals(DID_NOT_TAG_UP)
    const play = state.session.liveData.plays.allPlays.at(-1)!
    expect(play.result.eventType).equals('double_play')
    const doc = documentOf(state.session, play, {
      setupBefore: setupOf(start.session),
      actions: state.log
    })
    // The stored play's runners, as the document writes them.
    const stored = (doc.runners ?? []) as unknown as Array<{
      movement: { isOut: boolean }
      details: { movementReason: string | null }
    }>
    expect(
      stored
        .filter(runner => runner.movement.isOut)
        .map(runner => runner.details.movementReason)
    ).deep.equals([null, 'r_doubled_off'])
  })

  it('ends the half inning when he makes the third out', function () {
    let state = drop(caught(initial(1, 1)), 2, 1)
    state = tag(
      scoringReducer(state, { type: 'RUNNER_REASON', reason: DID_NOT_TAG_UP })
    )
    const play = state.session.liveData.plays.allPlays.at(-1)!
    expect(play.result.eventType).equals('double_play')
    expect(state.session.liveData.linescore.inningState).equals('Bottom')
  })

  it('makes a triple play when both runners are doubled off', function () {
    let state = drop(caught(initial(3)), 3, 2)
    state = tag(
      scoringReducer(state, { type: 'RUNNER_REASON', reason: DID_NOT_TAG_UP }),
      '2B'
    )
    expect(state.phase).equals('correctionWindow')
    state = drop(state, 2, 1)
    expect(state.phase).equals('runnerReason')
    state = tag(
      scoringReducer(state, { type: 'RUNNER_REASON', reason: DID_NOT_TAG_UP })
    )
    const play = state.session.liveData.plays.allPlays.at(-1)!
    expect(play.result.eventType).equals('triple_play')
    expect(
      play.runners
        .filter(runner => runner.movement.isOut)
        .map(runner => runner.details.movementReason)
    ).deep.equals(['Ball Caught', 'Ball Caught', 'Ball Caught'])
  })

  it('makes a sacrifice-fly double play when another runner tags and scores', function () {
    let state = drop(caught(initial(5)), 4, 4, 'safe')
    expect(state.session.liveData.linescore.teams.away.runs).equals(1)
    state = drop(state, 2, 1)
    expect(state.phase).equals('runnerReason')
    state = tag(
      scoringReducer(state, { type: 'RUNNER_REASON', reason: DID_NOT_TAG_UP })
    )
    const play = state.session.liveData.plays.allPlays.at(-1)!
    expect(play.result.eventType).equals('sac_fly_double_play')
  })

  it('is asked why on a caught foul too', function () {
    let state = caught(initial(2), 'C', { x: 30, z: -20 }, 60)
    expect(state.log.at(-1)).deep.include({ foulCaught: true })
    state = drop(state, 3, 2)
    expect(state.phase).equals('runnerReason')
    expect(runnerReasons(state)).deep.equals(CAUGHT_BALL_RETURN_OUT_REASONS)
    state = tag(
      scoringReducer(state, { type: 'RUNNER_REASON', reason: DID_NOT_TAG_UP }),
      '2B'
    )
    expect(runnerOut(state, 3).details.movementReason).equals('Ball Caught')
  })

  for (const reason of ['Offensive Interference', 'Out on Appeal', 'Other'])
    it(`records ${reason} on the caught play by whoever fielded it`, function () {
      let state = drop(caught(initial()), 2, 1)
      state = scoringReducer(state, { type: 'RUNNER_REASON', reason })
      // Not a throw from the fielder who caught it: the scorer picks.
      expect(state.phase).equals('chooseThrower')
      state = scoringReducer(state, {
        type: 'THROWER',
        id: defense(state, '1B'),
        point: { x: 60, z: -60 },
        generation: state.generation
      })
      state = completeMotions(
        scoringReducer(state, {
          type: 'DEFENDER',
          generation: state.generation
        })
      )
      expect(state.session.liveData.linescore.outs).equals(2)
      expect(runnerOut(state, 2).details.movementReason).equals(reason)
      expect(
        runnerOut(state, 2).credits.map(credit => [
          credit.player.id,
          credit.credit
        ])
      ).deep.equals([[defense(state, '1B'), 'f_putout']])
    })

  it('stays on his base when the menu is closed, and the clock waited', function () {
    let state = drop(caught(initial()), 2, 1)
    const left = state.correctionWindow!.remainingMs
    state = scoringReducer(state, {
      type: 'TIMER_TICK',
      elapsedMs: CORRECTION_WINDOW_MS,
      generation: state.generation,
      revision: state.correctionWindow!.revision
    })
    expect(state.phase).equals('runnerReason')
    state = scoringReducer(state, { type: 'RUNNER_CANCEL' })
    expect(state.phase).equals('correctionWindow')
    expect(state.runnerAction).equals(null)
    expect(state.correctionWindow!.remainingMs).equals(left)
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(baseIds(state.session)).deep.equals([2, null, null])
  })

  it('is not asked on a hit, nor when put out advancing or after moving up', function () {
    const single = drop(singleCorrection(initial()), 2, 2)
    expect(single.phase).equals('chooseDefender')
    expect(single.runnerAction!.reason).equals(undefined)
    const advancing = drop(caught(initial()), 2, 2)
    expect(advancing.phase).equals('chooseDefender')
    let moved = drop(caught(initial()), 2, 2, 'safe')
    expect(baseIds(moved.session)).deep.equals([null, 2, null])
    moved = drop(moved, 2, 2)
    expect(moved.phase).equals('chooseDefender')
    expect(moved.runnerAction!.reason).equals(undefined)
  })

  it('keeps the between-pitch menu once the caught play has closed', function () {
    const state = drop(expire(caught(initial(1, 0, 7))), 7, 1)
    expect(state.runnerAction!.origin).equals('between')
    expect(state.phase).equals('runnerReason')
    expect(runnerReasons(state)).deep.equals(STATIONARY_OUT_REASONS)
    expect(
      scoringReducer(state, { type: 'RUNNER_REASON', reason: DID_NOT_TAG_UP })
    ).equals(state)
  })
})
