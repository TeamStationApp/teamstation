import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { asScoringPlay } from './scoringContract'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { baseIds, playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

export function errorState(mask = 0): ScoringState {
  let state = initialScoringState(createDevelopmentSession(gameFixture, [], []))
  for (const [i, base] of (['first', 'second', 'third'] as const).entries())
    if ((mask & (1 << i)) !== 0)
      state.session.liveData.linescore.offense[base] = playerRef(
        state.session,
        i + 2
      )
  state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Error' })
  state = scoringReducer(state, {
    type: 'FIELDER',
    id: 10,
    point: { x: 0, z: -30 },
    generation: 0
  })
  return scoringReducer(state, { type: 'TRAJECTORY', angle: 25, generation: 0 })
}
describe('batted-ball error attribution', function () {
  for (let mask = 0; mask < 8; mask++)
    it(`advances occupancy ${mask} one base and credits one error after defenders`, function () {
      let state = errorState(mask)
      // Error awards one base: every occupied base advances, including unforced.
      expect(baseIds(state.session)).deep.equals([
        1,
        (mask & 1) !== 0 ? 2 : null,
        (mask & 2) !== 0 ? 3 : null
      ])
      expect(state.session.liveData.linescore.teams.away.hits).equals(0)
      expect(state.session.liveData.linescore.teams.home.errors).equals(0)
      state = completeMotions(state)
      expect(state.phase).equals('chooseDefender')
      expect(state.runnerAction!.purpose).equals('errorAttribution')
      expect(state.correctionWindow).equals(null)
      state = scoringReducer(state, {
        type: 'DEFENDER',
        generation: state.generation
      })
      expect(state.phase).equals('errorCredit')
      const selected = scoringReducer(state, {
        type: 'ERROR_CREDIT',
        id: 10,
        generation: state.generation
      })
      expect(selected.session.liveData.linescore.teams.home.errors).equals(1)
      expect(
        scoringReducer(selected, {
          type: 'ERROR_CREDIT',
          id: 10,
          generation: selected.generation
        })
      ).equals(selected)
      state = selected
      if ((mask & 4) !== 0) {
        expect(state.phase).equals('homeDecision')
        state = completeMotions(
          scoringReducer(state, { type: 'HOME', decision: 'safe' })
        )
      }
      expect(state.phase).equals('correctionWindow')
      state = scoringReducer(state, { type: 'CLOSE_PLAY' })
      const play = asScoringPlay(state.session.liveData.plays.allPlays.at(-1))
      expect(play.result.eventType).equals('field_error')
      expect(play.result.rbi).equals(0)
      expect(play.playEvents.filter(e => e.isPitch)).has.length(1)
      expect(play.source.gamestation.errorCredit!.player.id).equals(10)
      expect(
        play.source.gamestation.errorCredit!.defensiveRoute.map(
          hop => hop.player.id
        )
      ).deep.equals([10])
    })
  it('retains repeated transfers, rejects unlisted credit, cancels and rewinds without outs or duplicate counts', function () {
    let state = completeMotions(errorState(7))
    for (const id of [11, 12, 10])
      state = scoringReducer(state, {
        type: 'DEFENDER',
        id,
        point: { x: id, z: -30 },
        generation: state.generation
      })
    expect(state.session.liveData.linescore.outs).equals(0)
    expect(state.pendingPlay!.ballHolder).equals(10)
    expect(state.runnerAction!.defensiveRoute!.map(hop => hop.id)).deep.equals([
      10, 11, 12, 10
    ])
    state = scoringReducer(state, {
      type: 'DEFENDER',
      generation: state.generation
    })
    const cancel = scoringReducer(state, { type: 'ERROR_CANCEL' })
    expect(cancel.phase).equals('chooseDefender')
    expect(cancel.runnerAction!.defensiveRoute).deep.equals(
      state.runnerAction!.defensiveRoute
    )
    for (const [id, generation] of [
      [1, 0],
      [18, 0],
      [10, 99]
    ])
      expect(
        scoringReducer(state, { type: 'ERROR_CREDIT', id, generation })
      ).equals(state)
    const credited = scoringReducer(state, {
      type: 'ERROR_CREDIT',
      id: 11,
      generation: state.generation
    })
    const undone = scoringReducer(credited, { type: 'UNDO' })
    expect(undone.phase).equals('errorCredit')
    expect(undone.session.liveData.linescore.teams.home.errors).equals(0)
    expect(
      scoringReducer(undone, { type: 'ERROR_CREDIT', id: 10, generation: 0 })
    ).equals(undone)
    state = scoringReducer(undone, { type: 'UNDO' })
    expect(state.phase).equals('chooseDefender')
    state = scoringReducer(state, { type: 'UNDO' })
    expect(state.pendingPlay!.ballHolder).equals(12)
    while (state.past.length > 0)
      state = scoringReducer(state, { type: 'UNDO' })
    expect(baseIds(state.session)).deep.equals([2, 3, 4])
    expect(state.session.liveData.linescore.teams.home.errors).equals(0)
    expect(state.session.liveData.plays.currentPlay!.playEvents).has.length(0)
  })
})
