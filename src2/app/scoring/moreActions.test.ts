import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { moreEligibility, type MoreInput } from './moreActions'
import { asScoringPlay } from './scoringContract'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { baseIds, playerRef } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'
function initial(mask = 0): ScoringState {
  const state = initialScoringState(
    createDevelopmentSession(gameFixture, [], [])
  )
  for (const [i, key] of (['first', 'second', 'third'] as const).entries())
    if ((mask & (1 << i)) !== 0)
      state.session.liveData.linescore.offense[key] = playerRef(
        state.session,
        i + 2
      )
  return state
}
function more(state: ScoringState, input: MoreInput): ScoringState {
  return scoringReducer(state, { type: 'MORE', input })
}
function resolveHomes(state: ScoringState): ScoringState {
  state = completeMotions(state)
  while (state.homeQueue.length > 0)
    state = completeMotions(
      scoringReducer(state, { type: 'HOME', decision: 'safe' })
    )
  return state
}
describe('More local scoring actions', function () {
  for (const action of [
    'Hit by Pitch',
    'Intentional Walk',
    "Catcher's Interference"
  ] as const)
    it(`${action} awards only forced runners for every occupancy and counts only a delivered HBP`, function () {
      for (let mask = 0; mask < 8; mask++) {
        const start = initial(mask)
        const state = resolveHomes(more(start, { action }))
        expect(state.phase).equals('correctionWindow')
        expect(state.session.liveData.linescore.offense.first?.id).equals(1)
        expect(state.session.liveData.linescore.teams.away.runs).equals(
          mask === 7 ? 1 : 0
        )
        expect(
          state.session.liveData.boxscore.teams.home.pitchCounts[10] ?? 0
        ).equals(action === 'Hit by Pitch' ? 1 : 0)
        const play = state.session.liveData.plays.currentPlay!
        expect(play.result.event).equals(action)
        expect(play.hitData).equals(undefined)
        expect(
          play.runners.every(
            r =>
              r.details.movementReason === action ||
              r.details.movementReason === 'Safe at home'
          )
        ).equals(true)
        expect(play.playEvents.filter(e => e.isPitch)).has.length(
          action === 'Hit by Pitch' ? 1 : 0
        )
        expect(state.session.liveData.linescore.teams.away.hits).equals(0)
        asScoringPlay(play)
      }
    })
  it('awards balk bases without completing or advancing the batter appearance', function () {
    for (let mask = 1; mask < 8; mask++) {
      const start = initial(mask)
      const state = resolveHomes(more(start, { action: 'Balk' }))
      expect(state.phase).equals('ready')
      expect(state.pendingPlay).equals(null)
      expect(state.session.liveData.linescore.offense.batter?.id).equals(1)
      expect(state.session.liveData.plays.allPlays).has.length(0)
      expect(state.session.liveData.linescore.teams.away.runs).equals(
        (mask & 4) !== 0 ? 1 : 0
      )
      let undone = state
      while (undone.past.length > 0)
        undone = scoringReducer(undone, { type: 'UNDO' })
      expect(undone.session.liveData.linescore.offense).deep.equals(
        start.session.liveData.linescore.offense
      )
    }
  })
  it('requires legal manual placements and keeps them distinct from hit and pitch records', function () {
    const start = initial(7)
    for (const input of [
      { action: 'Put Batter on Base', base: 0 },
      { action: 'Put Batter on Base', base: 2 },
      {
        action: 'Put Batter on Base',
        base: 2,
        destinations: { 2: 3, 3: 3, 4: 4 }
      },
      {
        action: 'Put Batter on Base',
        base: 1,
        destinations: { 2: 3, 3: 2, 4: 4 }
      }
    ] as MoreInput[])
      expect(more(start, input)).equals(start)
    for (const base of [1, 2, 3]) {
      const state = resolveHomes(
        more(start, {
          action: 'Put Batter on Base',
          base,
          destinations: { 2: 4, 3: 4, 4: 4 }
        })
      )
      expect(baseIds(state.session)[base - 1]).equals(1)
      expect(state.session.liveData.linescore.teams.away.runs).equals(3)
      expect(
        state.session.liveData.plays.currentPlay!.playEvents.some(
          e => e.isPitch
        )
      ).equals(false)
      expect(state.session.liveData.linescore.teams.away.hits).equals(0)
    }
  })
  it('places only a roster player on an empty base without a pitch or batter completion', function () {
    const start = initial(1)
    for (const input of [
      { action: 'Place a Runner (Tiebreaker)', base: 1, playerId: 3 },
      { action: 'Place a Runner (Tiebreaker)', base: 2, playerId: 1 },
      { action: 'Place a Runner (Tiebreaker)', base: 2, playerId: 2 },
      { action: 'Place a Runner (Tiebreaker)', base: 2, playerId: 999 },
      { action: 'Place a Runner (Tiebreaker)', base: 4, playerId: 3 }
    ] as MoreInput[])
      expect(more(start, input)).equals(start)
    const state = more(start, {
      action: 'Place a Runner (Tiebreaker)',
      base: 2,
      playerId: 3
    })
    expect(baseIds(state.session)).deep.equals([2, 3, null])
    expect(state.phase).equals('ready')
    expect(
      state.session.liveData.plays.currentPlay!.playEvents[0].isPitch
    ).equals(false)
    expect(scoringReducer(state, { type: 'UNDO' }).session).deep.equals(
      start.session
    )
  })
  for (const action of ['Wild Pitch', 'Passed Ball'] as const)
    it(`${action} links the recent pitch across an appearance boundary and cancels completely`, function () {
      let state = initial()
      for (let n = 0; n < 4; n++)
        state = scoringReducer(state, { type: 'PITCH', kind: 'ball' })
      state = scoringReducer(completeMotions(state), { type: 'CLOSE_PLAY' })
      const before = state
      state = more(state, { action })
      expect(state.moreDraft?.action).equals(action)
      expect(
        JSON.stringify(scoringReducer(state, { type: 'RUNNER_CANCEL' }).session)
      ).equals(JSON.stringify(before.session))
      state = scoringReducer(state, {
        type: 'RUNNER_DROP',
        id: 1,
        to: 2,
        decision: 'safe',
        generation: state.generation
      })
      state = completeMotions(state)
      expect(state.phase).equals('ready')
      expect(state.moreDraft).equals(undefined)
      expect(state.session.liveData.boxscore.teams.home.pitchCounts[10]).equals(
        4
      )
      const record =
        state.session.liveData.plays.currentPlay!.source.gamestation.runnerActions!.at(
          -1
        )!
      expect(record.reason).equals(action)
      expect(record.pitchReference).deep.equals({ atBatIndex: 0, index: 3 })
      const dead = scoringReducer(state, { type: 'PITCH', kind: 'foul' })
      expect(moreEligibility(dead, action)).equals(
        'Record an eligible pitch first'
      )
      expect(more(dead, { action })).equals(dead)
    })
  it('enforces dropped-third eligibility and preserves the strikeout when the batter reaches', function () {
    for (const occupied of [false, true])
      for (const outs of [0, 2]) {
        let state = initial(occupied ? 1 : 0)
        state.session.liveData.linescore.outs = outs
        expect(moreEligibility(state, 'Strike Three, Not Caught')).not.equals(
          undefined
        )
        state = scoringReducer(state, { type: 'PITCH', kind: 'called' })
        state = scoringReducer(state, { type: 'PITCH', kind: 'swing' })
        if (occupied && outs === 0) {
          expect(more(state, { action: 'Strike Three, Not Caught' })).equals(
            state
          )
          continue
        }
        state = more(state, { action: 'Strike Three, Not Caught' })
        expect(state.phase).equals('resolveBatter')
        expect(state.session.liveData.linescore.outs).equals(outs)
        expect(
          state.session.liveData.boxscore.teams.home.pitchCounts[10]
        ).equals(3)
        if (!occupied) {
          state = resolveHomes(
            scoringReducer(state, {
              type: 'RUNNER_DROP',
              id: 1,
              to: 1,
              decision: 'safe',
              generation: state.generation
            })
          )
          expect(baseIds(state.session)[0]).equals(1)
          expect(
            state.session.liveData.plays.currentPlay!.result.eventType
          ).equals('strikeout')
        }
      }
  })
  it('records an unseen batter out only after credits and respects ready/runner eligibility', function () {
    let state = more(initial(), { action: 'Batter Out — Other' })
    expect(state.phase).equals('chooseThrower')
    expect(state.session.liveData.linescore.outs).equals(0)
    expect(moreEligibility(state, 'Intentional Walk')).equals(
      'Finish the current play first'
    )
    state = scoringReducer(state, {
      type: 'THROWER',
      id: 10,
      point: { x: 0, z: -18 },
      generation: state.generation
    })
    state = completeMotions(
      scoringReducer(state, { type: 'DEFENDER', generation: state.generation })
    )
    expect(state.session.liveData.linescore.outs).equals(1)
    expect(state.session.liveData.plays.currentPlay!.hitData).equals(undefined)
    expect(moreEligibility(initial(), 'Balk')).equals('No runners on base')
    const stale = initial(1)
    stale.recentPitch = { atBatIndex: 999, index: 0 }
    expect(more(stale, { action: 'Wild Pitch' })).equals(stale)
    const missing = initial()
    missing.session.liveData.plays.currentPlay = null
    expect(moreEligibility(missing, 'Balk')).equals(
      'Choose the next batter first'
    )
  })
})
