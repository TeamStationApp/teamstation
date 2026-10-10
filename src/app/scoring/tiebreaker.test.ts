import { expect } from 'chai'
import { describe, it } from 'mocha'

import { baseIds, tiebreakerSetupError } from '../../common/scoring/rules'
import { applyAction } from '../../common/scoring/session'
import { copyState } from '../../common/scoring/state'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { recentRunnerIds } from './tiebreaker'

const initial = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(createDevelopmentSession(gameFixture, [], []))
const place = (
  state: ReturnType<typeof initial>,
  playerId: number,
  base: number
): ReturnType<typeof initialScoringState> =>
  scoringReducer(state, {
    type: 'MORE',
    input: { action: 'Place a Runner (Tiebreaker)', playerId, base }
  })

describe('top-inning tiebreaker setup', () => {
  it('allows clean tops and refuses bottom halves, finished games and missing batters', () => {
    const state = initial().session
    expect(tiebreakerSetupError(state)).equals(undefined)
    const bottom = copyState(state)
    bottom.liveData.linescore.isTopInning = false
    expect(tiebreakerSetupError(bottom)).includes('top inning')
    expect(tiebreakerSetupError({ ...state, final: true })).equals(
      'The game is over'
    )
    const missing = copyState(state)
    missing.liveData.plays.currentPlay = null
    expect(tiebreakerSetupError(missing)).includes('next batter')
  })

  it('a first pitch blocks setup and Undo restores it', () => {
    const start = initial()
    const pitched = scoringReducer(start, { type: 'PITCH', kind: 'ball' })
    expect(tiebreakerSetupError(pitched.session)).includes('before the inning')
    expect(place(pitched, 2, 2)).equals(pitched)
    expect(
      tiebreakerSetupError(scoringReducer(pitched, { type: 'UNDO' }).session)
    ).equals(undefined)
  })

  it('detects any current-half completed play, actual action, count or pending play', () => {
    const state = initial().session
    for (const variant of ['finished', 'action', 'balls', 'strikes'] as const) {
      const next = copyState(state)
      const play = next.liveData.plays.currentPlay!
      if (variant === 'finished')
        next.liveData.plays.allPlays.push({
          ...play,
          about: { ...play.about, isComplete: true }
        })
      if (variant === 'action') {
        const placed = applyAction(next, {
          type: 'gameFlow',
          kind: 'placeRunner',
          runner: 2,
          base: '2B'
        }).state
        placed.liveData.plays.currentPlay!.playEvents[0].details.code = 'balk'
        expect(tiebreakerSetupError(placed)).includes('before the inning')
        continue
      }
      if (variant === 'balls') next.liveData.linescore.balls = 1
      if (variant === 'strikes') next.liveData.linescore.strikes = 1
      expect(tiebreakerSetupError(next), variant).includes('before the inning')
    }
    const pending = scoringReducer(initial(), {
      type: 'MORE',
      input: { action: 'Intentional Walk' }
    })
    expect(tiebreakerSetupError(pending.session)).not.equals(undefined)
  })

  it('permits multiple placements and outs setup, preserving all other game fields and Undo order', () => {
    const start = initial()
    const first = place(start, 2, 2)
    expect(tiebreakerSetupError(first.session)).equals(undefined)
    const changed = scoringReducer(first, { type: 'TIEBREAKER_OUTS', outs: 2 })
    expect(changed.past.at(-1)?.label).equals('Set Outs')
    expect(changed.session.liveData.linescore.outs).equals(2)
    expect(baseIds(changed.session)).deep.equals([null, 2, null])
    expect(changed.session.liveData.boxscore).deep.equals(
      first.session.liveData.boxscore
    )
    expect(changed.session.liveData.linescore.teams).deep.equals(
      first.session.liveData.linescore.teams
    )
    expect(changed.session.liveData.linescore.offense).deep.equals(
      first.session.liveData.linescore.offense
    )
    expect(changed.session.liveData.plays.currentPlay!.playEvents).deep.equals(
      first.session.liveData.plays.currentPlay!.playEvents
    )
    expect(tiebreakerSetupError(changed.session)).equals(undefined)
    const second = place(changed, 3, 1)
    expect(baseIds(second.session)).deep.equals([3, 2, null])
    const undoRunner = scoringReducer(second, { type: 'UNDO' })
    expect(undoRunner.session).deep.equals(changed.session)
    const undoOuts = scoringReducer(undoRunner, { type: 'UNDO' })
    expect(JSON.parse(JSON.stringify(undoOuts.session))).deep.equals(
      JSON.parse(JSON.stringify(first.session))
    )
    expect(scoringReducer(undoOuts, { type: 'UNDO' }).session).deep.equals(
      start.session
    )
  })

  it('outs accepts only changed integers 0–2 at a clean top and protects read-only scoring', () => {
    const start = initial()
    for (const outs of [0, -1, 3, 0.5, NaN, Infinity])
      expect(scoringReducer(start, { type: 'TIEBREAKER_OUTS', outs })).equals(
        start
      )
    const pitched = scoringReducer(start, { type: 'PITCH', kind: 'ball' })
    expect(
      scoringReducer(pitched, { type: 'TIEBREAKER_OUTS', outs: 1 })
    ).equals(pitched)
    const readonly = { ...start, readOnly: true }
    const result = scoringReducer(readonly, {
      type: 'TIEBREAKER_OUTS',
      outs: 1
    })
    expect(result.log).deep.equals(start.log)
    expect(result.session.liveData.linescore.outs).equals(0)
    const one = scoringReducer(start, { type: 'TIEBREAKER_OUTS', outs: 1 })
    expect(scoringReducer(one, { type: 'TIEBREAKER_OUTS', outs: 1 })).equals(
      one
    )
    expect(
      scoringReducer(one, { type: 'TIEBREAKER_OUTS', outs: 0 }).session.liveData
        .linescore.outs
    ).equals(0)
  })

  it('restricts new engine/dictation actions while keeping legacy placement replay valid', () => {
    const pitched = scoringReducer(initial(), {
      type: 'PITCH',
      kind: 'ball'
    }).session
    const action = {
      type: 'gameFlow',
      kind: 'placeRunner',
      runner: 2,
      base: '2B'
    } as const
    expect(applyAction(pitched, action).problems).deep.equals([])
    expect(
      applyAction(pitched, action, { requireCurrentSetup: true }).problems[0]
        ?.code
    ).equals('notNow')
    const result = scoringReducer(initialScoringState(pitched), {
      type: 'DICTATED',
      transcript: 'place runner on second',
      actions: [action]
    })
    expect(result.session).deep.equals(pitched)
    expect(result.dictation?.problem?.code).equals('notNow')
  })

  it('lists never-batted players in reversed batting order, excluding current batter, bench and occupied players', () => {
    const state = initial().session
    expect(recentRunnerIds(state)).deep.equals([9, 8, 7, 6, 5, 4, 3, 2])
    const placed = applyAction(state, {
      type: 'gameFlow',
      kind: 'placeRunner',
      runner: 9,
      base: '2B'
    }).state
    expect(recentRunnerIds(placed)).deep.equals([8, 7, 6, 5, 4, 3, 2])
    placed.liveData.boxscore.teams.away.battingOrder = []
    expect(recentRunnerIds(placed)).deep.equals([])
  })

  it('starts from the latest completed batting slot and follows a substitute in that slot', () => {
    const state = initial().session
    const finished = copyState(state.liveData.plays.currentPlay!)
    finished.matchup.batter.id = 3
    finished.about.isComplete = true
    state.liveData.plays.allPlays.push(finished)
    state.liveData.boxscore.teams.away.battingIndex = 3
    state.liveData.linescore.offense.batter!.id = 4
    expect(recentRunnerIds(state)).deep.equals([3, 2, 1, 9, 8, 7, 6, 5])
    state.liveData.boxscore.teams.away.battingOrder[2] = 99
    expect(recentRunnerIds(state)).deep.equals([99, 2, 1, 9, 8, 7, 6, 5])
    delete finished.lineups
    expect(recentRunnerIds(state)).deep.equals([99, 2, 1, 9, 8, 7, 6, 5])
  })
})
