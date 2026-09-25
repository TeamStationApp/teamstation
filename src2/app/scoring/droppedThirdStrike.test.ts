import { expect } from 'chai'
import { describe, it } from 'mocha'

import { homeBackProposal } from '../../common/scoring/rules'
import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { moreEligibility } from './moreActions'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { baseIds, playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

function start(mask = 0, outs = 0): ScoringState {
  let state = initialScoringState(createDevelopmentSession(gameFixture, [], []))
  for (const [i, key] of (['first', 'second', 'third'] as const).entries())
    if ((mask & (1 << i)) !== 0)
      state.session.liveData.linescore.offense[key] = playerRef(
        state.session,
        i + 2
      )
  state.session.liveData.linescore.outs = outs
  for (let i = 0; i < 2; i++)
    state = scoringReducer(state, { type: 'PITCH', kind: 'called' })
  return state
}
function drop(state: ScoringState): ScoringState {
  return scoringReducer(state, {
    type: 'MORE',
    input: { action: 'Dropped Third Strike' }
  })
}
function retire(state: ScoringState): ScoringState {
  state = scoringReducer(state, {
    type: 'THROWER',
    id: 11,
    point: { x: 0, z: 1 },
    generation: state.generation
  })
  state = scoringReducer(state, {
    type: 'DEFENDER',
    generation: state.generation
  })
  return completeMotions(state)
}
describe('automatic dropped third strike', () => {
  const expectedBases = [
    [1, null, null],
    [1, 2, null],
    [1, 3, null],
    [1, 2, 3],
    [1, null, 4],
    [1, 2, 4],
    [1, 3, 4],
    [1, 2, 3]
  ]
  const expectedDestinations = [
    [],
    [[2, 1, 2]],
    [[3, 2, 2]],
    [
      [2, 1, 2],
      [3, 2, 3]
    ],
    [[4, 3, 3]],
    [
      [2, 1, 2],
      [4, 3, 3]
    ],
    [
      [3, 2, 2],
      [4, 3, 3]
    ],
    [
      [2, 1, 2],
      [3, 2, 3],
      [4, 3, 4]
    ]
  ]
  for (let mask = 0; mask < 8; mask++)
    it(`advances only forced runners for occupancy ${mask} and records safe once`, () => {
      const before = start(mask, (mask & 1) !== 0 ? 2 : 0)
      let state = drop(before)
      expect(state.phase).equals('runnerMovement')
      expect(state.runnerAction).equals(null)
      expect(state.correctionWindow).equals(null)
      expect(state.motions.some(m => m.playerId === 1 && !m.complete)).equals(
        true
      )
      expect(baseIds(state.session)).deep.equals(expectedBases[mask])
      expect(
        state.session
          .pending!.movements.filter(m => m.playerId !== 1)
          .map(m => [m.playerId, m.from, m.to])
      ).deep.equals(expectedDestinations[mask])
      for (const [id, from, to] of expectedDestinations[mask])
        expect(state.motions.filter(m => m.playerId === id)).has.length(
          from === to ? 0 : 1
        )
      const undone = scoringReducer(state, { type: 'UNDO' })
      expect(undone.session).deep.equals(before.session)
      expect(
        scoringReducer(undone, {
          type: 'MOTION_DONE',
          id: state.motions[0].id,
          generation: state.generation
        })
      ).equals(undone)
      state = completeMotions(state)
      if (mask === 7) {
        expect(state.phase).equals('homeDecision')
        expect(state.session.homeQueue).deep.equals([4])
        expect(baseIds(state.session)).deep.equals([1, 2, 3])
        expect(homeBackProposal(state.session)).equals(null)
        state = completeMotions(
          scoringReducer(state, { type: 'HOME', decision: 'safe' })
        )
      } else {
        expect(state.phase).equals('runnerDecision')
        expect(state.runnerAction).includes({
          playerId: 1,
          from: 0,
          to: 1,
          purpose: 'droppedThirdStrike'
        })
        expect(
          scoringReducer(state, { type: 'RUNNER_PROPOSE', id: 1, to: 2 })
        ).equals(state)
        expect(scoringReducer(state, { type: 'CANCEL_RUNNER' })).equals(state)
        const motionIds = state.motions.map(m => m.id)
        state = scoringReducer(state, {
          type: 'RUNNER_DECIDE',
          decision: 'safe'
        })
        expect(state.motions.map(m => m.id)).deep.equals(motionIds)
      }
      expect(baseIds(state.session)).deep.equals(expectedBases[mask])
      expect(state.phase).equals('correctionWindow')
      expect(state.correctionWindow?.remainingMs).equals(10000)
      const play = state.session.liveData.plays.currentPlay!
      expect(play.result.eventType).equals('strikeout')
      expect(play.result.rbi).equals(0)
      expect(play.runners.filter(r => r.details.runner.id === 1)).has.length(1)
      expect(state.session.liveData.boxscore.teams.home.pitchCounts[10]).equals(
        3
      )
      expect(state.session.liveData.linescore.teams.away.runs).equals(
        mask === 7 ? 1 : 0
      )
      const restored = scoringReducer(state, { type: 'UNDO' })
      expect(restored.phase).equals(
        mask === 7 ? 'homeDecision' : 'runnerDecision'
      )
      const done = scoringReducer(state, { type: 'CLOSE_PLAY' })
      // Forced runner may occupy the next scheduled batter's base; existing roster repair remains available.
      expect(done.phase).oneOf(['ready', 'awaitingBatter'])
      expect(done.session.liveData.plays.allPlays).has.length(1)
    })
  it('waits ten seconds after Safe, ignores stale ticks, and resets after runner edits', () => {
    let state = completeMotions(drop(start()))
    state = scoringReducer(state, { type: 'RUNNER_DECIDE', decision: 'safe' })
    const timer = {
      type: 'TIMER_TICK' as const,
      generation: state.generation,
      revision: state.correctionWindow!.revision,
      elapsedMs: 3000
    }
    state = scoringReducer(state, timer)
    expect(state.correctionWindow!.remainingMs).equals(7000)
    state = scoringReducer(state, {
      type: 'RUNNER_DROP',
      id: 1,
      to: 2,
      decision: 'safe',
      generation: state.generation
    })
    state = completeMotions(state)
    expect(state.phase).equals('correctionWindow')
    expect(state.correctionWindow!.remainingMs).equals(10000)
    expect(scoringReducer(state, timer)).equals(state)
    state = scoringReducer(state, {
      ...timer,
      revision: state.correctionWindow!.revision,
      elapsedMs: 10000
    })
    expect(state.session.liveData.plays.allPlays).has.length(1)
    expect(baseIds(state.session)[1]).equals(1)
    expect(state.session.liveData.linescore.offense.batter!.id).equals(2)
  })
  it('rejects first occupied before two outs and keeps the old phrase out of eligibility', () => {
    const state = start(1)
    expect(moreEligibility(state, 'Dropped Third Strike')).not.equals(undefined)
    expect(drop(state)).equals(state)
  })
  for (const loaded of [false, true])
    for (const outs of loaded ? [2] : [0, 2])
      it(`credits an out after defense (${loaded ? 'loaded' : 'empty'}, ${outs} outs)`, () => {
        let state = completeMotions(drop(start(loaded ? 7 : 0, outs)))
        state = scoringReducer(
          state,
          loaded
            ? { type: 'HOME', decision: 'out' }
            : { type: 'RUNNER_DECIDE', decision: 'out' }
        )
        expect(state.phase).equals('chooseThrower')
        state = retire(state)
        expect(state.session.liveData.linescore.teams.away.runs).equals(0)
        const play = state.session.liveData.plays.allPlays.at(-1)!
        expect(play.result.eventType).equals('strikeout')
        expect(play.runners.filter(r => r.movement.isOut)).has.length(1)
        expect(play.runners.at(-1)!.credits).deep.equals([
          {
            player: { id: 11, fullName: 'Player 2' },
            credit: 'f_putout',
            position: 'C'
          }
        ])
        if (outs === 2)
          expect(state.session.liveData.linescore.isTopInning).equals(false)
        else expect(state.session.liveData.linescore.outs).equals(1)
      })
})
