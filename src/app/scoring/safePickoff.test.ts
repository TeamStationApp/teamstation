import { expect } from 'chai'
import { describe, it } from 'mocha'

import { cleanAction } from '../../common/scoring/actions'
import { baseIds } from '../../common/scoring/rules'
import { applyAction } from '../../common/scoring/session'
import { BASES } from '../field/fieldModel'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

function initial(base: number, animate: boolean): ScoringState {
  const state = initialScoringState(
    createDevelopmentSession(gameFixture, [], [])
  )
  state.session.liveData.linescore.offense[
    (['first', 'second', 'third'] as const)[base - 1]
  ] = playerRef(state.session, 2)
  return {
    ...scoringReducer(state, { type: 'PITCH', kind: 'ball' }),
    presentationEnabled: animate
  }
}
function safe(state: ScoringState, base: number): ScoringState {
  return scoringReducer(state, {
    type: 'RUNNER_DROP',
    id: 2,
    to: base,
    decision: 'safe',
    generation: state.generation
  })
}

describe('safe pickoff from a runner drag', () => {
  for (const base of [1, 2, 3])
    for (const animate of [false, true])
      it(`records a failed pitcher-to-base ${base} attempt, animation ${animate}`, () => {
        const before = initial(base, animate)
        const defense = before.session.liveData.linescore.defense
        const receiver = defense[(['1B', '2B', '3B'] as const)[base - 1]]!.id
        let state = safe(before, base)
        const action = state.log.at(-1)!
        expect(action).deep.include({
          type: 'runnerMovement',
          runner: 2,
          reason: 'Safe from Pickoff',
          fielders: [defense.P!.id, receiver]
        })
        expect(state.session.liveData.linescore).deep.equals(
          before.session.liveData.linescore
        )
        expect(state.session.liveData.boxscore).deep.equals(
          before.session.liveData.boxscore
        )
        const play = state.session.liveData.plays.currentPlay!
        expect(play.matchup.batter.id).equals(
          before.session.liveData.plays.currentPlay!.matchup.batter.id
        )
        expect(play.playEvents).has.length(2)
        expect(play.playEvents[1].isPitch).equals(false)
        const attempt = play.source.teamstation.runnerActions!.at(-1)!
        expect(attempt).deep.include({
          reason: 'Safe from Pickoff',
          isOut: false,
          origin: base,
          destination: base
        })
        expect(attempt.credits).deep.equals([])
        expect(attempt.defensiveRoute!.map(hop => hop.player.id)).deep.equals([
          defense.P!.id,
          receiver
        ])
        expect(attempt.defenderLocation).deep.equals(BASES[base])
        const cleaned = cleanAction(JSON.parse(JSON.stringify(action)))
        if ('problem' in cleaned) throw new Error(cleaned.problem.message)
        const replayed = applyAction(before.session, cleaned.action)
        expect(replayed.problems).deep.equals([])
        expect(replayed.state).deep.equals(state.session)
        if (animate) {
          const sequence = state.presentation!
          expect(sequence).deep.include({
            kind: 'throw',
            thrower: defense.P!.id,
            receiver,
            safe: true
          })
          expect(sequence.kind === 'throw' && sequence.to).deep.include(
            BASES[base]
          )
          expect(
            scoringReducer(state, {
              type: 'PRESENTATION_DONE',
              id: sequence.id,
              generation: sequence.generation + 1,
              stage: sequence.stage
            })
          ).equals(state)
          state = scoringReducer(state, {
            type: 'PRESENTATION_DONE',
            id: sequence.id,
            generation: sequence.generation,
            stage: sequence.stage
          })
          expect(state.presentation).equals(null)
          expect(state.log).has.length(before.log.length + 1)
        } else expect(state.presentation).equals(null)
        expect(state.phase).equals('ready')
        expect(state.runnerAction).equals(null)
        expect(state.runnerDraft).equals(undefined)
        expect(state.past).has.length(before.past.length + 1)
        expect(baseIds(state.session)).deep.equals(baseIds(before.session))
        expect(scoringReducer(state, { type: 'UNDO' }).session).deep.equals(
          before.session
        )
      })

  it('undoes an in-flight safe throw and ignores its late completion', () => {
    const before = initial(1, true)
    const state = safe(before, 1)
    const sequence = state.presentation!
    const undone = scoringReducer(state, { type: 'UNDO' })
    expect(undone.session).deep.equals(before.session)
    expect(
      scoringReducer(undone, {
        type: 'PRESENTATION_DONE',
        id: sequence.id,
        generation: sequence.generation,
        stage: sequence.stage
      })
    ).equals(undone)
  })

  it('keeps the safe result recoverable when a defender is missing', () => {
    for (const position of ['P', '1B'] as const) {
      const state = initial(1, true)
      state.session.liveData.linescore.defense[position] = null
      const result = safe(state, 1)
      expect(result.phase).equals('ready')
      expect(result.presentation).equals(null)
      expect(result.log.at(-1)).deep.include({ reason: 'Safe from Pickoff' })
      expect(baseIds(result.session)).deep.equals([2, null, null])
    }
  })

  it('records a safe attempt without inventing positions for incomplete throw details', () => {
    const before = initial(1, false)
    const defense = before.session.liveData.linescore.defense
    for (const locations of [undefined, [], [BASES[1]]]) {
      const result = applyAction(before.session, {
        type: 'runnerMovement',
        runner: 2,
        to: '1B',
        reason: 'Safe from Pickoff',
        fielders: [defense.P!.id, defense['1B']!.id],
        locations
      })
      expect(result.problems).deep.equals([])
      const attempt =
        result.state.liveData.plays.currentPlay!.source.teamstation.runnerActions!.at(
          -1
        )!
      expect(attempt.reason).equals('Safe from Pickoff')
      expect(attempt.defensiveRoute).equals(undefined)
      expect(attempt.credits).deep.equals([])
      expect(baseIds(result.state)).deep.equals([2, null, null])
    }
  })
})
