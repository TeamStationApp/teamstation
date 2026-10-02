import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  dictatedAction,
  type ScoringAction
} from '../../common/scoring/actions'
import { applyAction } from '../../common/scoring/session'
import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import type { ScoringEvent, ScoringSessionState } from './scoringTypes'

/**
 * One half inning two ways: tapped on the scoring screen, and read from an
 * action script in the shape a dictation interpreter sends — no separate
 * contact step, no explicit closes, the next pitch closing a decided play.
 * They must make the same game.
 */
function script(): ScoringAction[] {
  const raw = JSON.parse(
    readFileSync('src/common/scoring/fixtures/halfInning.actions.json', 'utf8')
  ) as unknown[]
  return raw.map(entry => {
    const cleaned = dictatedAction(
      String((entry as { type?: unknown }).type),
      entry
    )
    if ('problem' in cleaned) throw new Error(cleaned.problem.message)
    return cleaned.action
  })
}
function tapped(): ScoringSessionState {
  let state = initialScoringState(createDevelopmentSession(gameFixture, [], []))
  const tap = (event: ScoringEvent): void => {
    state = completeMotions(scoringReducer(state, event))
  }
  const close = (): void => {
    tap({ type: 'CLOSE_PLAY', generation: state.generation })
  }
  tap({ type: 'PITCH', kind: 'ball' })
  tap({ type: 'PITCH', kind: 'called' })
  tap({ type: 'OUTCOME', outcome: 'Single' })
  tap({
    type: 'FIELDER',
    id: 17,
    point: { x: 5, z: -80 },
    generation: state.generation
  })
  tap({ type: 'TRAJECTORY', angle: 15, generation: state.generation })
  close()
  tap({ type: 'PITCH', kind: 'called' })
  tap({ type: 'PITCH', kind: 'swing' })
  tap({ type: 'PITCH', kind: 'swing' })
  close()
  tap({ type: 'OUTCOME', outcome: 'Throw Out' })
  tap({
    type: 'FIELDER',
    id: 14,
    point: { x: -20, z: -40 },
    generation: state.generation
  })
  tap({ type: 'TRAJECTORY', angle: -10, generation: state.generation })
  tap({
    type: 'DEFENDER',
    id: 12,
    point: { x: 20, z: -20 },
    generation: state.generation
  })
  tap({ type: 'DEFENDER', generation: state.generation })
  tap({
    type: 'RUNNER_DROP',
    id: 1,
    to: 2,
    decision: 'safe',
    generation: state.generation
  })
  close()
  tap({ type: 'OUTCOME', outcome: 'Ball Caught' })
  tap({
    type: 'FIELDER',
    id: 16,
    point: { x: -45, z: -75 },
    generation: state.generation
  })
  tap({ type: 'TRAJECTORY', angle: 40, generation: state.generation })
  return state.session
}
/** The game without its action counter, which counts taps and words differently. */
function game(state: ScoringSessionState): unknown {
  const copy = JSON.parse(JSON.stringify(state)) as ScoringSessionState
  copy.meta.sequence = 0
  return copy
}

describe('a dictated half inning and a tapped one', function () {
  it('make the same game, plays, credits and line score', function () {
    let dictated = createDevelopmentSession(gameFixture, [], [])
    for (const action of script()) {
      const applied = applyAction(dictated, action)
      expect(applied.problems, JSON.stringify(action)).deep.equals([])
      dictated = applied.state
    }
    const byTaps = tapped()
    expect(dictated.liveData.linescore.isTopInning).equals(false)
    expect(
      dictated.liveData.plays.allPlays.map(play => play.result.eventType)
    ).deep.equals(['single', 'strikeout', 'field_out', 'field_out'])
    expect(dictated.liveData.plays.allPlays).deep.equals(
      byTaps.liveData.plays.allPlays
    )
    expect(dictated.liveData.linescore).deep.equals(byTaps.liveData.linescore)
    expect(game(dictated)).deep.equals(game(byTaps))
  })
})
