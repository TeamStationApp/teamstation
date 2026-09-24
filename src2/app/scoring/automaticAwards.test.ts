import { expect } from 'chai'
import { describe, it } from 'mocha'

import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import type { MoreAction } from './moreActions'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { baseIds, canSwitchBatter, playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

function finish(state: ScoringState): ScoringState {
  for (let i = 0; i < 50; i++) {
    expect(state.phase).not.equals('homeDecision')
    expect(state.phase).not.equals('correctionWindow')
    if (state.presentation != null) {
      const p = state.presentation
      state = scoringReducer(state, {
        type: 'PRESENTATION_DONE',
        id: p.id,
        generation: p.generation,
        stage: p.stage
      })
    } else {
      const m = state.motions.find(m => !m.complete)
      if (m == null) return state
      state = scoringReducer(state, {
        type: 'MOTION_DONE',
        id: m.id,
        generation: m.generation
      })
    }
  }
  throw new Error('Award did not settle')
}
describe('automatic awarded bases', function () {
  for (const animated of [false, true])
    for (const action of [
      'Hit by Pitch',
      'Intentional Walk',
      "Catcher's Interference",
      'Walk',
      'Balk'
    ])
      it(`${action} settles safely with every occupancy (animation ${animated})`, function () {
        for (let mask = action === 'Balk' ? 1 : 0; mask < 8; mask++) {
          let state = initialScoringState(
            createDevelopmentSession(gameFixture, [], []),
            animated
          )
          for (const [index, base] of (
            ['first', 'second', 'third'] as const
          ).entries())
            if ((mask & (1 << index)) !== 0)
              state.session.liveData.linescore.offense[base] = playerRef(
                state.session,
                index + 6
              )
          if (action === 'Walk')
            for (let i = 0; i < 3; i++)
              state = finish(
                scoringReducer(state, { type: 'PITCH', kind: 'ball' })
              )
          const before = state
          state =
            action === 'Walk'
              ? scoringReducer(state, { type: 'PITCH', kind: 'ball' })
              : scoringReducer(state, {
                  type: 'MORE',
                  input: { action: action as MoreAction }
                })
          const pending = state
          state = finish(state)
          const runs =
            action === 'Balk' ? ((mask & 4) === 0 ? 0 : 1) : mask === 7 ? 1 : 0
          expect(state.session.liveData.linescore.teams.away.runs).equals(runs)
          expect(state.phase).equals('ready')
          expect(state.session.liveData.linescore.offense.batter!.id).equals(
            action === 'Balk' ? 1 : 2
          )
          expect(state.correctionWindow).equals(null)
          expect(state.homeQueue).length(0)
          const play =
            action === 'Balk'
              ? state.session.liveData.plays.currentPlay!
              : state.session.liveData.plays.allPlays.at(-1)!
          expect(
            play.runners.filter(r => r.movement.runScored === true)
          ).length(runs)
          expect(play.result.rbi).equals(action === 'Balk' ? 0 : runs)
          expect(
            new Set(baseIds(state.session).filter(id => id != null)).size
          ).equals(baseIds(state.session).filter(id => id != null).length)
          if (pending.motions[0] != null)
            expect(
              scoringReducer(state, {
                type: 'MOTION_DONE',
                id: pending.motions[0].id,
                generation: pending.generation
              })
            ).equals(state)
          const undo = scoringReducer(state, { type: 'UNDO' })
          expect(undo.session).deep.equals(before.session)
          expect(undo.phase).equals(before.phase)
        }
      })
  for (const bats of ['left', 'right', 'switch'] as const)
    it(`lets a ${bats} hitter change boxes only before a pitch`, function () {
      let state = initialScoringState(
        createDevelopmentSession(gameFixture, [], [])
      )
      state.session.gameData.players[1].bats = bats
      expect(canSwitchBatter(state.session)).equals(true)
      state = scoringReducer(state, { type: 'SWITCH_SIDE', side: 'L' })
      expect(
        state.session.liveData.plays.currentPlay!.matchup.batSide.code
      ).equals('L')
      state = scoringReducer(state, { type: 'PITCH', kind: 'foul' })
      expect(canSwitchBatter(state.session)).equals(false)
      expect(scoringReducer(state, { type: 'SWITCH_SIDE', side: 'R' })).equals(
        state
      )
      state = scoringReducer(state, { type: 'UNDO' })
      expect(canSwitchBatter(state.session)).equals(true)
    })
})
