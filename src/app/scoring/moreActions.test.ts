import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions } from '../../test/scoringHelpers'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { moreEligibility, type MoreInput } from './moreActions'
import { asScoringPlay } from './scoringContract'
import { runnerReasons } from './scoringFlow'
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
  while (state.session.homeQueue.length > 0)
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
        expect(state.phase).oneOf(['ready', 'awaitingBatter'])
        expect(state.session.liveData.linescore.offense.first?.id).equals(1)
        expect(state.session.liveData.linescore.teams.away.runs).equals(
          mask === 7 ? 1 : 0
        )
        expect(
          state.session.liveData.boxscore.teams.home.pitchCounts[10] ?? 0
        ).equals(action === 'Hit by Pitch' ? 1 : 0)
        const play = state.session.liveData.plays.allPlays.at(-1)!
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
  it('places batters immediately only with empty bases and preserves counts and Undo', function () {
    for (let mask = 0; mask < 8; mask++)
      for (const base of [1, 2, 3]) {
        const start = initial(mask)
        const result = more(start, { action: 'Put Batter on Base', base })
        if (mask !== 0) {
          expect(result).equals(start)
          continue
        }
        const state = completeMotions(result)
        expect(state.phase).equals('ready')
        expect(state.pendingPlay).equals(null)
        expect(state.correctionWindow).equals(null)
        expect(state.session.homeQueue).deep.equals([])
        expect(baseIds(state.session)[base - 1]).equals(1)
        expect(state.session.liveData.linescore.offense.batter?.id).equals(2)
        expect(state.session.liveData.linescore.teams.away.hits).equals(0)
        expect(
          state.session.liveData.plays.allPlays
            .at(-1)!
            .playEvents.some(e => e.isPitch)
        ).equals(false)
        expect(scoringReducer(state, { type: 'UNDO' }).session).deep.equals(
          start.session
        )
      }
    for (const base of [undefined, 0, 4]) {
      const start = initial()
      expect(more(start, { action: 'Put Batter on Base', base })).equals(start)
    }
  })
  for (const reason of ['Wild Pitch', 'Passed Ball'])
    it(`${reason} advances just the chosen runner without a pitch or RBI`, () => {
      for (const from of [1, 2, 3])
        for (const pitch of [false, true]) {
          let start = initial(1 << (from - 1))
          const id = from + 1
          if (pitch)
            start = scoringReducer(start, { type: 'PITCH', kind: 'ball' })
          const count =
            start.session.liveData.boxscore.teams.home.pitchCounts[10] ?? 0
          const draft = scoringReducer(start, {
            type: 'RUNNER_DROP',
            id,
            to: from + 1,
            decision: 'safe',
            generation: start.generation
          })
          expect(runnerReasons(draft)).includes(reason)
          expect(
            scoringReducer(draft, { type: 'RUNNER_CANCEL' }).session
          ).deep.equals(start.session)
          const final = completeMotions(
            scoringReducer(draft, { type: 'RUNNER_REASON', reason })
          )
          expect(final.phase).equals('ready')
          expect(final.session.liveData.linescore.offense.batter?.id).equals(1)
          expect(final.session.liveData.linescore.balls).equals(pitch ? 1 : 0)
          expect(
            final.session.liveData.boxscore.teams.home.pitchCounts[10] ?? 0
          ).equals(count)
          expect(final.session.liveData.linescore.teams.away.runs).equals(
            from === 3 ? 1 : 0
          )
          const play = final.session.liveData.plays.currentPlay!
          expect(play.result.rbi).equals(0)
          expect(play.playEvents.at(-1)!.details.code).equals(
            reason === 'Wild Pitch' ? 'wild_pitch' : 'passed_ball'
          )
          expect(play.playEvents.at(-1)!.isPitch).equals(false)
          expect(
            play.source.gamestation.runnerActions!.at(-1)!.pitchReference
          ).deep.equals(pitch ? start.session.recentPitch : undefined)
          expect(scoringReducer(final, { type: 'UNDO' }).session).deep.equals(
            start.session
          )
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
        expect(moreEligibility(state, 'Dropped Third Strike')).not.equals(
          undefined
        )
        state = scoringReducer(state, { type: 'PITCH', kind: 'called' })
        state = scoringReducer(state, { type: 'PITCH', kind: 'swing' })
        if (occupied && outs === 0) {
          expect(more(state, { action: 'Dropped Third Strike' })).equals(state)
          continue
        }
        state = more(state, { action: 'Dropped Third Strike' })
        expect(state.phase).equals('runnerMovement')
        expect(state.session.liveData.linescore.outs).equals(outs)
        expect(
          state.session.liveData.boxscore.teams.home.pitchCounts[10]
        ).equals(3)
        state = completeMotions(state)
        expect(state.phase).equals('runnerDecision')
        if (!occupied) {
          state = resolveHomes(
            scoringReducer(state, {
              type: 'RUNNER_DECIDE',
              decision: 'safe'
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
    stale.session.recentPitch = { atBatIndex: 999, index: 0 }
    expect(more(stale, { action: 'Wild Pitch' })).equals(stale)
    const missing = initial()
    missing.session.liveData.plays.currentPlay = null
    expect(moreEligibility(missing, 'Balk')).equals(
      'Choose the next batter first'
    )
  })
})
