import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions, singleCorrection } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  chainAhead,
  chainAllowed,
  chainBackError,
  chainDropError,
  commitChain
} from './runnerChain'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { baseIds, playerRef } from './scoringSelectors'
import {
  CORRECTION_WINDOW_MS,
  type ScoringEvent,
  type ScoringState
} from './scoringTypes'

/** Runners 2, 3 and 4 on the bases `mask` names (1st, 2nd, 3rd), after a ball. */
function onBases(mask: readonly number[], outs = 0): ScoringState {
  const state = initialScoringState(scoringSession(gameFixture))
  const offense = state.session.liveData.linescore.offense
  const keys = ['first', 'second', 'third'] as const
  for (const base of mask)
    offense[keys[base - 1]] = playerRef(state.session, base + 1)
  state.session.liveData.linescore.outs = outs
  return scoringReducer(state, { type: 'PITCH', kind: 'ball' })
}
function run(state: ScoringState, ...events: ScoringEvent[]): ScoringState {
  for (const event of events) state = scoringReducer(state, event)
  return state
}
function drop(
  state: ScoringState,
  id: number,
  to: number,
  decision: 'safe' | 'out'
): ScoringState {
  return scoringReducer(state, {
    type: 'RUNNER_DROP',
    id,
    to,
    decision,
    generation: state.generation
  })
}
function decide(
  state: ScoringState,
  id: number,
  decision: 'safe' | 'out' | 'back'
): ScoringState {
  return scoringReducer(state, {
    type: 'CHAIN_DECIDE',
    id,
    decision,
    generation: state.generation
  })
}
/** The Caught Stealing steps after Out: catcher to the fielder at the base. */
function caughtStealing(state: ScoringState, to: number): ScoringState {
  state = run(state, { type: 'RUNNER_REASON', reason: 'Caught Stealing' })
  state = run(state, {
    type: 'THROWER',
    id: state.session.liveData.linescore.defense.C!.id,
    point: { x: 0, z: 2 },
    generation: state.generation
  })
  const receiver =
    state.session.liveData.linescore.defense[
      (['1B', '2B', '3B', 'C'] as const)[(to - 1) % 4]
    ]!.id
  state = run(state, {
    type: 'DEFENDER',
    id: receiver,
    point: { x: 0, z: -38 },
    generation: state.generation
  })
  return completeMotions(
    run(state, { type: 'DEFENDER', generation: state.generation })
  )
}
function steal(state: ScoringState): ScoringState {
  return completeMotions(run(state, { type: 'RUNNER_REASON', reason: 'Steal' }))
}
const bases = (state: ScoringState): Array<number | null> =>
  baseIds(state.session)
const outs = (state: ScoringState): number =>
  state.session.liveData.linescore.outs

describe('runner chain', function () {
  it('lists the runners on the consecutive occupied bases ahead (U3)', function () {
    const masks: Array<[number[], number, number[]]> = [
      [[], 1, []],
      [[1], 1, []],
      [[1, 2], 1, [3]],
      [[1, 3], 1, []],
      [[2, 3], 2, [4]],
      [[1, 2, 3], 1, [3, 4]],
      [[1, 2, 3], 2, [4]],
      [[1, 2, 3], 3, []],
      [[2], 1, [3]],
      [[3], 2, [4]],
      [[2, 3], 1, [3, 4]]
    ]
    for (const [mask, from, ids] of masks) {
      const state = onBases(mask)
      const pushed = chainAhead(state.session, from)
      expect(pushed.map(runner => runner.playerId)).deep.equals(ids)
      for (const runner of pushed) expect(runner.to).equals(runner.from + 1)
    }
    expect(chainAhead(onBases([1, 2]).session, 0)).deep.equals([])
  })

  it('clears a base the chain empties and refuses everything else (U3)', function () {
    const state = onBases([1, 2])
    expect(chainDropError(state, 2, 2)).equals(undefined)
    // The tap path keeps the library's answer.
    expect(chainDropError({ ...state, phase: 'runnerReason' }, 2, 2)).match(
      /occupied/
    )
    // No pass: the drag still covers one base.
    expect(chainDropError(state, 2, 3)).match(/pass/)
    // A non-chain occupied base: runner on 1st and 3rd, 2nd to 3rd is not his.
    const corners = onBases([1, 3])
    expect(chainDropError(corners, 2, 2)).equals(undefined)
    const second = onBases([2, 3])
    expect(chainDropError(second, 3, 3)).equals(undefined)
    expect(chainDropError(second, 3, 4)).match(/pass/)
    expect(chainAllowed(state)).equals(true)
    expect(chainAllowed({ ...state, phase: 'resolveBatter' })).equals(false)
    expect(chainAllowed({ ...state, phase: 'fieldersChoice' })).equals(false)
    expect(chainAllowed({ ...state, phase: 'homeDecision' })).equals(false)
    expect(chainAllowed({ ...state, phase: 'correctionWindow' })).equals(true)
    expect(
      chainDropError(
        {
          ...state,
          runnerChain: {
            dragged: { playerId: 2, from: 1, to: 2 },
            pushed: [{ playerId: 3, from: 2, to: 3, decision: 'back' }]
          }
        },
        2,
        2
      )
    ).match(/occupied/)
    // A runner outside the open chain answers as the library does.
    expect(
      chainDropError(
        {
          ...state,
          runnerChain: {
            dragged: { playerId: 9, from: 1, to: 2 },
            pushed: [{ playerId: 3, from: 2, to: 3 }]
          }
        },
        2,
        2
      )
    ).match(/occupied/)
  })

  it('allows Back only once the runner behind is out (U3)', function () {
    const chain = (
      dragged: 'safe' | 'out' | 'back' | undefined,
      third?: 'safe' | 'out' | 'back'
    ): Pick<ScoringState, 'runnerChain'> => ({
      runnerChain: {
        dragged: { playerId: 2, from: 1, to: 2, decision: dragged },
        pushed: [
          { playerId: 3, from: 2, to: 3, decision: third },
          { playerId: 4, from: 3, to: 4 }
        ]
      }
    })
    expect(chainBackError(chain(undefined), 3)).match(/behind/)
    expect(chainBackError(chain('safe'), 3)).match(/behind/)
    expect(chainBackError(chain('out'), 3)).equals(undefined)
    expect(chainBackError(chain('out'), 4)).match(/behind/)
    expect(chainBackError(chain('out', 'safe'), 4)).match(/behind/)
    expect(chainBackError(chain('out', 'back'), 4)).match(/behind/)
    expect(chainBackError(chain('out', 'out'), 4)).equals(undefined)
    // Nobody headed to his base: a ground chain of only 3rd to home.
    expect(
      chainBackError(
        {
          runnerChain: {
            pushed: [
              { playerId: 2, from: 1, to: 2, decision: 'out' },
              { playerId: 4, from: 3, to: 4 }
            ]
          }
        },
        4
      )
    ).equals(undefined)
    expect(chainBackError({}, 4)).match(/unavailable/)
    // Nothing to commit without a chain.
    const state = onBases([1])
    commitChain(state)
    expect(bases(state)).deep.equals([2, null, null])
  })

  it('double steal: both safe, lead first, back to ready (U4)', function () {
    const before = onBases([1, 2])
    let state = drop(before, 2, 2, 'safe')
    expect(state.phase).equals('runnerReason')
    expect(state.runnerChain?.pushed.map(r => r.playerId)).deep.equals([3])
    state = steal(state)
    expect(state.phase).equals('chainDecision')
    expect(state.log).deep.equals(before.log)
    expect(bases(state)).deep.equals([2, 3, null])
    expect(state.past).has.length(before.past.length + 1)
    state = decide(state, 3, 'safe')
    expect(state.phase).equals('runnerReason')
    state = steal(state)
    expect(state.phase).equals('ready')
    expect(state.runnerChain).equals(undefined)
    expect(bases(state)).deep.equals([null, 2, 3])
    const moves = state.log.slice(before.log.length)
    expect(
      moves.map(action => (action as { runner?: number }).runner)
    ).deep.equals([3, 2])
    // Undo: the pop-up is back, then the drag is gone.
    const once = scoringReducer(state, { type: 'UNDO' })
    expect(once.phase).equals('chainDecision')
    expect(once.runnerChain?.pushed[0].decision).equals(undefined)
    expect(once.log).deep.equals(before.log)
    const twice = scoringReducer(once, { type: 'UNDO' })
    expect(twice.phase).equals('ready')
    expect(twice.runnerChain).equals(undefined)
    expect(bases(twice)).deep.equals([2, 3, null])
    expect(twice.log).deep.equals(before.log)
  })

  it('cancels the drag and a pushed runner’s reason with nothing logged (U4)', function () {
    const before = onBases([1, 2])
    const draft = drop(before, 2, 2, 'safe')
    const cancelled = scoringReducer(draft, { type: 'RUNNER_CANCEL' })
    expect(cancelled.phase).equals('ready')
    expect(cancelled.runnerChain).equals(undefined)
    let state = steal(drop(cancelled, 2, 2, 'safe'))
    const pops = state
    state = decide(state, 3, 'out')
    expect(state.phase).equals('runnerReason')
    state = scoringReducer(state, { type: 'RUNNER_CANCEL' })
    expect(state.phase).equals('chainDecision')
    expect(state.log).deep.equals(before.log)
    expect(state.runnerChain).deep.equals(pops.runnerChain)
    expect(state.past).deep.equals(pops.past)
    // Undo inside a pushed runner's steps cancels them too.
    state = scoringReducer(decide(state, 3, 'out'), { type: 'UNDO' })
    expect(state.phase).equals('chainDecision')
    // Back is refused while the runner behind is safe, and stale taps are ignored.
    expect(decide(state, 3, 'back')).equals(state)
    expect(
      scoringReducer(state, {
        type: 'CHAIN_DECIDE',
        id: 3,
        decision: 'safe',
        generation: state.generation - 1
      })
    ).equals(state)
    expect(decide(state, 4, 'safe')).equals(state)
    expect(decide(before, 3, 'safe')).equals(before)
    // Pitches and other drags wait for the pop-ups.
    expect(scoringReducer(state, { type: 'PITCH', kind: 'ball' })).equals(state)
    expect(drop(state, 3, 3, 'safe')).equals(state)
  })

  it('dragged runner out, pushed runner back: one out, runner still on 2nd (U4)', function () {
    const before = onBases([1, 2])
    let state = caughtStealing(drop(before, 2, 2, 'out'), 2)
    expect(state.phase).equals('chainDecision')
    expect(outs(state)).equals(0)
    expect(chainBackError(state, 3)).equals(undefined)
    state = decide(state, 3, 'back')
    state = completeMotions(state)
    expect(state.phase).equals('ready')
    expect(bases(state)).deep.equals([null, 3, null])
    expect(outs(state)).equals(1)
  })

  it('bases loaded: dragged out, 2nd pushed out, 3rd pushed back (U4)', function () {
    const before = onBases([1, 2, 3])
    let state = caughtStealing(drop(before, 2, 2, 'out'), 2)
    expect(state.runnerChain?.pushed.map(r => r.playerId)).deep.equals([3, 4])
    expect(chainBackError(state, 4)).match(/behind/)
    state = decide(state, 3, 'out')
    expect(state.phase).equals('runnerReason')
    state = caughtStealing(state, 3)
    expect(state.phase).equals('chainDecision')
    expect(chainBackError(state, 4)).equals(undefined)
    state = completeMotions(decide(state, 4, 'back'))
    expect(bases(state)).deep.equals([null, null, 4])
    expect(outs(state)).equals(2)
    expect(state.session.liveData.linescore.teams.away.runs ?? 0).equals(0)
  })

  it('answers in any order give the same game (U4)', function () {
    const before = onBases([1, 2, 3])
    const start = steal(drop(before, 2, 2, 'safe'))
    const leadFirst = steal(decide(steal(decide(start, 4, 'safe')), 3, 'safe'))
    const leadLast = steal(decide(steal(decide(start, 3, 'safe')), 4, 'safe'))
    expect(completeMotions(leadFirst).session.liveData.linescore).deep.equals(
      completeMotions(leadLast).session.liveData.linescore
    )
    expect(bases(completeMotions(leadFirst))).deep.equals([null, 2, 3])
    expect(leadFirst.log.slice(before.log.length)).deep.equals(
      leadLast.log.slice(before.log.length)
    )
  })

  it('the third out ends the chain at once (U4)', function () {
    // Two outs, runners on 1st and 2nd, dragged runner Caught Stealing.
    let state = caughtStealing(drop(onBases([1, 2], 2), 2, 2, 'out'), 2)
    expect(state.runnerChain).equals(undefined)
    expect(state.phase).not.equals('chainDecision')
    expect(state.session.liveData.linescore.isTopInning).equals(false)
    // One out, bases loaded: dragged out, then the runner pushed to 3rd out.
    state = caughtStealing(drop(onBases([1, 2, 3], 1), 2, 2, 'out'), 2)
    expect(state.phase).equals('chainDecision')
    state = caughtStealing(decide(state, 3, 'out'), 3)
    expect(state.runnerChain).equals(undefined)
    expect(state.phase).not.equals('chainDecision')
    expect(state.session.liveData.linescore.isTopInning).equals(false)
  })

  it('pop-ups after a decided play pause the window until the last answer (U5)', function () {
    let state = initialScoringState(scoringSession(gameFixture))
    state.session.liveData.linescore.offense.first = playerRef(state.session, 3)
    state = singleCorrection(state)
    expect(state.phase).equals('correctionWindow')
    const batter = bases(state)[0]!
    expect(bases(state)[1]).equals(3)
    state = completeMotions(drop(state, batter, 2, 'safe'))
    expect(state.phase).equals('chainDecision')
    const paused = scoringReducer(state, {
      type: 'TIMER_TICK',
      elapsedMs: 1000,
      generation: state.generation,
      revision: state.correctionWindow!.revision
    })
    expect(paused).equals(state)
    state = completeMotions(decide(state, 3, 'safe'))
    expect(state.phase).equals('correctionWindow')
    expect(state.correctionWindow?.remainingMs).equals(CORRECTION_WINDOW_MS)
    expect(bases(state)).deep.equals([null, batter, 3])
    const undone = scoringReducer(state, { type: 'UNDO' })
    expect(undone.phase).equals('chainDecision')
    expect(bases(undone)).deep.equals([batter, 3, null])
  })
})
