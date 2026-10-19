import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions, singleCorrection } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  copyGame,
  copyState,
  initialScoringState,
  scoringReducer
} from './scoringMachine'
import type { ScoringState } from './scoringTypes'

function appearance(state: ScoringState, index: number): ScoringState {
  const pitches =
    index % 2 === 0
      ? (['foul', 'called', 'ball', 'ball', 'swing'] as const)
      : (['ball', 'foul', 'ball', 'ball', 'ball'] as const)
  for (const kind of pitches)
    state = completeMotions(scoringReducer(state, { type: 'PITCH', kind }))
  return scoringReducer(state, { type: 'CLOSE_PLAY' })
}

function deepFreeze(value: unknown): void {
  if (value == null || typeof value !== 'object' || Object.isFrozen(value))
    return
  Object.freeze(value)
  for (const key of Object.keys(value))
    deepFreeze((value as Record<string, unknown>)[key])
}

describe('copying a game for the screen', function () {
  it('copies as copyState does, sharing the finished plays a copy made', function () {
    let state = initialScoringState(scoringSession(gameFixture))
    for (let index = 0; index < 4; index++) state = appearance(state, index)
    const first = copyGame(state.session)
    expect(first).deep.equals(copyState(state.session))
    const second = copyGame(first)
    expect(second).deep.equals(first)
    expect(second.liveData.plays.allPlays).has.length(4)
    second.liveData.plays.allPlays.forEach((play, index) => {
      expect(play).equals(first.liveData.plays.allPlays[index])
    })
    // Everything else is the copy's own.
    expect(second.liveData.linescore).not.equals(first.liveData.linescore)
    expect(second.liveData.plays).not.equals(first.liveData.plays)
    expect(second.liveData.plays.allPlays).not.equals(
      first.liveData.plays.allPlays
    )
  })

  it('never changes a finished play the copies share, through play and Undo', function () {
    let state = initialScoringState(scoringSession(gameFixture))
    for (let index = 0; index < 12; index++) {
      state = appearance(state, index)
      // Frozen, a play that anything changed would throw.
      deepFreeze(state.session.liveData.plays.allPlays)
    }
    state = singleCorrection(state)
    state = scoringReducer(state, { type: 'CLOSE_PLAY' })
    deepFreeze(state.session.liveData.plays.allPlays)
    const scored = JSON.stringify(state.session)
    let undone = state
    for (let step = 0; step < 40; step++)
      undone = scoringReducer(undone, { type: 'UNDO' })
    expect(undone.session.liveData.plays.allPlays.length).lessThan(12)
    // The game Undo left the history holding is unchanged too.
    expect(JSON.stringify(state.session)).equals(scored)
    for (let index = 0; index < 3; index++) undone = appearance(undone, index)
    expect(JSON.stringify(state.session)).equals(scored)
  })
})
