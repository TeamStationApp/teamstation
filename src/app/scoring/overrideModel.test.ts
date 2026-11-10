import { expect } from 'chai'
import { describe, it } from 'mocha'

import { applyAction } from '../../common/scoring/apply'
import { statLines, strikeoutBatter } from '../../common/scoring/credits'
import { finalDocumentOf } from '../../common/scoring/document'
import { halfPitcher } from '../../common/scoring/earnedRuns'
import { overrideOf } from '../../common/scoring/lineup'
import {
  baseIds,
  currentSetupError,
  rosterError,
  tiebreakerSetupError
} from '../../common/scoring/rules'
import { asGameState, setupOf } from '../../common/scoring/state'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from './isUnscoredGame.test'
import { overrideActions, overrideHalf } from './overrideModel'
import {
  initialScoringState,
  overrideProblem,
  scoringReducer
} from './scoringMachine'

const initial = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(scoringSession(gameFixture))
describe('override settings model', function () {
  it('records a move from a later duplicate turn to the first occurrence', function () {
    let state = initial()
    state.session.liveData.boxscore.teams.away.battingOrder = [1, 2, 1, 3]
    state.session.liveData.boxscore.teams.away.battingIndex = 2
    state = scoringReducer(state, { type: 'PITCH', kind: 'ball' })
    const selected = scoringReducer(state, {
      type: 'OVERRIDE',
      draft: { ...overrideOf(state.session), batterIndex: 0 }
    })
    expect(selected.log.at(-1)).property('batterIndex', 0)
    expect(selected.session.overrideLineupSetup).equals(true)
    const draft = structuredClone(selected.session)
    draft.liveData.boxscore.teams.away.battingOrder[0] = 9
    const replaced = scoringReducer(selected, { type: 'ROSTER', draft })
    expect(
      replaced.session.liveData.boxscore.teams.away.battingOrder
    ).deep.equals([9, 2, 1, 3])
    expect(replaced.session.liveData.boxscore.teams.away.battingIndex).equals(0)
    expect(replaced.session.liveData.linescore.offense.batter?.id).equals(9)
  })
  it('clears a changed half, persists its action, repairs the pitcher and undoes atomically', function () {
    const state = initial()
    const draft = overrideHalf(state.session, overrideOf(state.session), false)
    expect(draft).includes({ top: false, pitcher: null, batter: 10 })
    expect(draft.bases).deep.equals([null, null, null])
    const prepared = overrideActions(state.session, draft)
    if ('error' in prepared) throw new Error(prepared.error)
    expect(prepared.actions[0]).property('clearPitcher', true)
    const applied = applyAction(state.session, prepared.actions[0])
    expect(applied.problems).deep.equals([])
    expect(currentSetupError(applied.state)).equals('Missing pitcher')
    expect(applied.state.liveData.plays.currentPlay).equals(null)
    const next = scoringReducer(state, { type: 'OVERRIDE', draft })
    expect(next.session.liveData.linescore.defense.P).equals(null)
    expect(tiebreakerSetupError(next.session)).includes('top inning')
    expect(scoringReducer(next, { type: 'UNDO' }).session).deep.equals(
      state.session
    )
    const setup = setupOf(next.session)
    setup.sides.away.defense.P = 1
    const repaired = applyAction(next.session, {
      type: 'lineup',
      kind: 'roster',
      setup
    })
    expect(repaired.problems).deep.equals([])
    expect(
      repaired.state.liveData.plays.currentPlay?.matchup.pitcher.id
    ).equals(1)
    expect(tiebreakerSetupError(repaired.state)).includes('top inning')
    const correction = overrideActions(repaired.state, {
      ...overrideOf(repaired.state),
      bases: [null, 11, null]
    })
    if ('error' in correction) throw new Error(correction.error)
    const placed = applyAction(repaired.state, correction.actions[0])
    expect(placed.problems).deep.equals([])
    expect(baseIds(placed.state)).deep.equals([null, 11, null])
    expect(
      placed.state.liveData.linescore.offense.reachedOnError?.second
    ).equals(false)
    expect(placed.state.liveData.plays.currentPlay!.playEvents).deep.equals([])
    const pitch = applyAction(placed.state, { type: 'pitch', call: 'B' })
    expect(pitch.problems).deep.equals([])
    expect(tiebreakerSetupError(pitch.state)).includes('top inning')
    const back = overrideHalf(repaired.state, overrideOf(repaired.state), true)
    expect(back.pitcher).equals(null)
    expect(overrideActions(repaired.state, back)).not.property('error')
  })
  it('restores original context on switching back and preserves it for other edits', function () {
    const state = initial()
    state.session.liveData.linescore.offense.first = {
      id: 2,
      fullName: 'Mike Trout'
    }
    const original = overrideOf(state.session)
    const bottom = overrideHalf(
      state.session,
      { ...original, pinchHitter: 9 },
      false
    )
    expect(bottom.pinchHitter).equals(undefined)
    const back = overrideHalf(state.session, bottom, true)
    expect(back.pitcher).equals(original.pitcher)
    expect(back.bases).deep.equals(original.bases)
    for (const change of [
      { balls: 3 },
      { inning: 50 },
      { awayScore: 100000 }
    ]) {
      const next = scoringReducer(state, {
        type: 'OVERRIDE',
        draft: { ...original, ...change }
      })
      expect(next.session.liveData.linescore.defense.P?.id).equals(
        original.pitcher
      )
      expect(baseIds(next.session)).deep.equals(original.bases)
    }
  })
  it('stages a pinch hitter and clears the departed defender while preserving count and the current pitcher', function () {
    const state = initial()
    // The fixture has nine players per side; a player removed from the order is a bench player.
    state.session.liveData.boxscore.teams.away.battingOrder = [
      1, 2, 3, 4, 5, 6, 7, 8
    ]
    const before = setupOf(state.session)
    const draft = {
      ...overrideOf(state.session),
      balls: 2,
      strikes: 1,
      pinchHitter: 9
    }
    const prepared = overrideActions(state.session, draft)
    expect(prepared).not.property('error')
    const next = scoringReducer(state, { type: 'OVERRIDE', draft })
    expect(next.log).length(2)
    expect(next.session.liveData.linescore.offense.batter?.id).equals(9)
    expect(next.session.liveData.linescore).includes({ balls: 2, strikes: 1 })
    expect(next.session.liveData.boxscore.teams.away.battingOrder).deep.equals([
      9, 2, 3, 4, 5, 6, 7, 8
    ])
    expect(next.session.liveData.boxscore.teams.away.defense).deep.equals({
      ...before.sides.away.defense,
      P: null
    })
    expect(next.session.liveData.linescore.defense.P?.id).equals(draft.pitcher)
    expect(scoringReducer(next, { type: 'UNDO' }).session).deep.equals(
      state.session
    )
  })
  it('keeps a non-opening slot pinch hitter at bat before the first pitch and on replay', function () {
    const state = initial()
    state.session.liveData.boxscore.teams.away.battingOrder.pop()
    const draft = { ...overrideOf(state.session), batter: 5, pinchHitter: 9 }
    const next = scoringReducer(state, { type: 'OVERRIDE', draft })
    expect(next.session.liveData.linescore.offense.batter?.id).equals(9)
    expect(next.session.liveData.boxscore.teams.away.battingIndex).equals(4)
    expect(next.session.liveData.boxscore.teams.away.battingOrder).deep.equals([
      1, 2, 3, 4, 9, 6, 7, 8
    ])
    let replayed = state.session
    for (const action of next.log) {
      const result = applyAction(replayed, JSON.parse(JSON.stringify(action)))
      expect(result.problems).deep.equals([])
      replayed = result.state
    }
    expect(replayed.liveData.linescore.offense.batter?.id).equals(9)
    expect(replayed.liveData.boxscore.teams.away.battingIndex).equals(4)
    expect(scoringReducer(next, { type: 'UNDO' }).session).deep.equals(
      state.session
    )
  })
  it('rejects missing, in-lineup, occupied and foreign bench players without partial mutation', function () {
    const state = initial()
    const draft = overrideOf(state.session)
    for (const changed of [
      { batter: null },
      { balls: 4 },
      { pinchHitter: 2 },
      { pinchHitter: 10 },
      { pitcher: null },
      { batterIndex: -1 },
      { batterIndex: 1.5 },
      { batterIndex: 99 },
      { batterIndex: 2 }
    ]) {
      expect(overrideActions(state.session, { ...draft, ...changed })).property(
        'error'
      )
      expect(
        scoringReducer(state, {
          type: 'OVERRIDE',
          draft: { ...draft, ...changed }
        })
      ).equals(state)
    }
    state.session.liveData.boxscore.teams.away.battingOrder.pop()
    expect(
      overrideActions(state.session, {
        ...draft,
        bases: [9, null, null],
        pinchHitter: 9
      })
    ).property('error')
    const cleared = applyAction(state.session, {
      type: 'gameFlow',
      kind: 'override',
      clearPitcher: true
    })
    expect(cleared.problems[0].message).includes('pitcher')
    const half = overrideHalf(state.session, draft, false)
    const changed = scoringReducer(state, { type: 'OVERRIDE', draft: half })
    expect(
      overrideActions(changed.session, {
        ...overrideOf(changed.session),
        homeScore: 2
      })
    ).not.property('error')
  })
  it('preserves an overridden batting slot when assigning the missing pitcher on returning to Top 1', function () {
    const state = initial()
    const bottom = scoringReducer(state, {
      type: 'OVERRIDE',
      draft: overrideHalf(state.session, overrideOf(state.session), false)
    })
    const top = scoringReducer(bottom, {
      type: 'OVERRIDE',
      draft: {
        ...overrideHalf(bottom.session, overrideOf(bottom.session), true),
        batter: 5,
        batterIndex: 4
      }
    })
    const draft = structuredClone(top.session)
    draft.liveData.boxscore.teams.home.defense.P = 10
    const repaired = scoringReducer(top, { type: 'ROSTER', draft })
    expect(repaired.session.liveData.linescore.offense.batter?.id).equals(5)
    expect(repaired.session.liveData.boxscore.teams.away.battingIndex).equals(4)
    expect(
      repaired.session.liveData.plays.currentPlay?.matchup.pitcher.id
    ).equals(10)
    let replayed = state.session
    for (const action of repaired.log) {
      const result = applyAction(replayed, JSON.parse(JSON.stringify(action)))
      expect(result.problems).deep.equals([])
      replayed = result.state
    }
    expect(replayed.liveData.linescore.offense.batter?.id).equals(5)
    expect(replayed.liveData.boxscore.teams.away.battingIndex).equals(4)
    expect(scoringReducer(repaired, { type: 'UNDO' }).session).deep.equals(
      top.session
    )
  })
  it('selects and pinch hits only the chosen occurrence in a merged historical lineup', function () {
    const state = initial()
    state.session.liveData.boxscore.teams.away.battingOrder = [
      1, 2, 3, 4, 1, 6, 7, 8
    ]
    const selected = { ...overrideOf(state.session), batter: 1, batterIndex: 4 }
    const skipped = scoringReducer(state, { type: 'OVERRIDE', draft: selected })
    expect(skipped.session.liveData.boxscore.teams.away.battingIndex).equals(4)
    const next = scoringReducer(state, {
      type: 'OVERRIDE',
      draft: { ...selected, pinchHitter: 9 }
    })
    expect(next.session.liveData.boxscore.teams.away.battingOrder).deep.equals([
      1, 2, 3, 4, 9, 6, 7, 8
    ])
    expect(next.session.liveData.boxscore.teams.away.battingIndex).equals(4)
    expect(next.session.liveData.linescore.offense.batter?.id).equals(9)
    let replayed = state.session
    for (const action of next.log) {
      const result = applyAction(replayed, JSON.parse(JSON.stringify(action)))
      expect(result.problems).deep.equals([])
      replayed = result.state
    }
    expect(replayed.liveData.boxscore.teams.away.battingOrder).deep.equals([
      1, 2, 3, 4, 9, 6, 7, 8
    ])
    expect(replayed.liveData.boxscore.teams.away.battingIndex).equals(4)
    expect(scoringReducer(next, { type: 'UNDO' }).session).deep.equals(
      state.session
    )
  })
  for (const countSetup of [
    'pitched',
    'separate override',
    'combined override'
  ])
    it(`charges a two-strike pinch-hit strikeout to the replaced occurrence: ${countSetup}`, function () {
      let state = initial()
      state.session.liveData.boxscore.teams.away.battingOrder = [
        1, 2, 3, 4, 1, 6, 7, 8
      ]
      state = scoringReducer(state, {
        type: 'OVERRIDE',
        draft: {
          ...overrideOf(state.session),
          batter: 1,
          batterIndex: 4
        }
      })
      if (countSetup === 'pitched') {
        state = scoringReducer(state, { type: 'PITCH', kind: 'called' })
        state = scoringReducer(state, { type: 'PITCH', kind: 'called' })
      } else if (countSetup === 'separate override') {
        state = scoringReducer(state, {
          type: 'OVERRIDE',
          draft: {
            ...overrideOf(state.session),
            batterIndex: 4,
            strikes: 2
          }
        })
      }
      const before = state.session
      const prepared = overrideActions(before, {
        ...overrideOf(before),
        batterIndex: 4,
        strikes: 2,
        pinchHitter: 9
      })
      if ('error' in prepared) throw new Error(prepared.error)
      for (const replay of [false, true]) {
        let scored = before
        for (const action of [
          ...prepared.actions,
          { type: 'pitch' as const, call: 'S' as const },
          { type: 'gameFlow' as const, kind: 'closePlay' as const }
        ]) {
          const result = applyAction(
            scored,
            replay ? JSON.parse(JSON.stringify(action)) : action
          )
          expect(result.problems).deep.equals([])
          scored = result.state
        }
        const play = scored.liveData.plays.allPlays.at(-1)!
        expect(strikeoutBatter(play)).equals(1)
        expect(statLines([play]).batting[1]).includes({ pa: 1, ab: 1, k: 1 })
        expect(statLines([play]).batting[9]).equals(undefined)
        expect(scored.liveData.boxscore.teams.away.battingOrder).deep.equals([
          1, 2, 3, 4, 9, 6, 7, 8
        ])
      }
      // Legacy plain roster saves keep their old fold: no PH announcement for
      // a defender entering the order without an explicit replacement action.
      if (countSetup === 'pitched') {
        const legacy = JSON.parse(JSON.stringify(prepared.actions))
        delete legacy[1].player
        delete legacy[1].replaces
        let scored = before
        for (const action of [
          ...legacy,
          { type: 'pitch', call: 'S' },
          { type: 'gameFlow', kind: 'closePlay' }
        ]) {
          const result = applyAction(scored, action)
          expect(result.problems).deep.equals([])
          scored = result.state
        }
        const play = scored.liveData.plays.allPlays.at(-1)!
        expect(
          play.playEvents.some(
            event => event.details.code === 'offensive_substitution'
          )
        ).equals(false)
        expect(strikeoutBatter(play)).equals(1)
        expect(statLines([play]).batting[1]).includes({ pa: 1, ab: 1, k: 1 })
      }
      const roster = prepared.actions[1]
      expect(
        applyAction(before, {
          ...roster,
          type: 'lineup',
          kind: 'roster',
          replaces: 2
        }).problems
      ).has.length.greaterThan(0)
    })
  it('retains a two-strike replacement through a missing pitcher, saved state and undo', function () {
    const original = initial()
    original.session.liveData.boxscore.teams.home.battingOrder.pop()
    const draft = {
      ...overrideHalf(original.session, overrideOf(original.session), false),
      strikes: 2,
      pinchHitter: 18
    }
    const staged = scoringReducer(original, { type: 'OVERRIDE', draft })
    expect(staged.session.liveData.plays.currentPlay).equals(null)
    expect(staged.session.pendingLineupEvents).has.length(1)
    expect(scoringReducer(staged, { type: 'UNDO' }).session).deep.equals(
      original.session
    )
    for (const saved of [false, true]) {
      let state = saved
        ? asGameState(JSON.parse(JSON.stringify(staged.session)))
        : staged.session
      const setup = setupOf(state)
      setup.sides.away.defense.P = 1
      for (const action of [
        { type: 'lineup' as const, kind: 'roster' as const, setup },
        { type: 'pitch' as const, call: 'S' as const },
        { type: 'gameFlow' as const, kind: 'closePlay' as const }
      ]) {
        const result = applyAction(state, action)
        expect(result.problems).deep.equals([])
        state = result.state
      }
      const play = state.liveData.plays.allPlays.at(-1)!
      expect(strikeoutBatter(play)).equals(10)
      expect(statLines([play]).batting[10]).includes({ pa: 1, ab: 1, k: 1 })
      expect(statLines([play]).batting[18]).equals(undefined)
      expect(state.pendingLineupEvents).equals(undefined)
    }
    for (const action of [
      { type: 'gameFlow' as const, kind: 'endHalf' as const },
      {
        type: 'gameFlow' as const,
        kind: 'override' as const,
        top: true,
        batter: 1
      },
      { type: 'gameFlow' as const, kind: 'override' as const, batter: 11 }
    ]) {
      const result = applyAction(staged.session, action)
      expect(result.problems).deep.equals([])
      const events =
        result.state.pendingLineupEvents ??
        result.state.liveData.plays.currentPlay?.playEvents ??
        []
      expect(events.some(event => event.replacedPlayer?.id === 10)).equals(true)
    }
  })
  it('keeps the selected merged slot and pending replacement when changing halves', function () {
    const original = initial()
    original.session.liveData.boxscore.teams.home.battingOrder = [
      10, 11, 12, 13, 10, 15, 16, 17
    ]
    const draft = {
      ...overrideHalf(original.session, overrideOf(original.session), false),
      batterIndex: 4,
      strikes: 2,
      pinchHitter: 18
    }
    const prepared = overrideActions(original.session, draft)
    if ('error' in prepared) throw new Error(prepared.error)
    let state = original.session
    for (const action of prepared.actions) {
      const result = applyAction(state, action)
      expect(result.problems).deep.equals([])
      state = result.state
    }
    expect(state.liveData.boxscore.teams.home.battingIndex).equals(4)
    expect(state.liveData.linescore.offense.batter?.id).equals(18)
    expect(
      state.pendingLineupEvents?.some(event => event.replacedPlayer?.id === 10)
    ).equals(true)
    state = asGameState(JSON.parse(JSON.stringify(state)))
    const setup = setupOf(state)
    setup.sides.away.defense.P = 1
    for (const action of [
      { type: 'lineup' as const, kind: 'roster' as const, setup },
      { type: 'pitch' as const, call: 'S' as const },
      { type: 'gameFlow' as const, kind: 'closePlay' as const }
    ]) {
      const result = applyAction(state, action)
      expect(result.problems).deep.equals([])
      state = result.state
    }
    expect(strikeoutBatter(state.liveData.plays.allPlays.at(-1)!)).equals(10)
  })
  it('preserves pitched history during a same-half score edit while the pitcher is unset', function () {
    let state = initial().session
    for (const call of ['C', 'B'] as const)
      state = applyAction(state, { type: 'pitch', call }).state
    const events = state.liveData.plays.currentPlay!.playEvents
    const setup = setupOf(state)
    const pitcher = setup.sides.home.defense.P
    setup.sides.home.defense.P = null
    state = applyAction(state, { type: 'lineup', kind: 'roster', setup }).state
    const prepared = overrideActions(state, {
      ...overrideOf(state),
      awayScore: 2
    })
    if ('error' in prepared) throw new Error(prepared.error)
    for (const action of prepared.actions) {
      const result = applyAction(state, action)
      expect(result.problems).deep.equals([])
      state = result.state
    }
    expect(
      state.liveData.plays.currentPlay!.playEvents.slice(0, 2)
    ).deep.equals(events)
    expect(currentSetupError(state)).equals('Missing pitcher')
    setup.sides.home.defense.P = pitcher
    const repaired = applyAction(
      asGameState(JSON.parse(JSON.stringify(state))),
      { type: 'lineup', kind: 'roster', setup }
    )
    expect(repaired.problems).deep.equals([])
    expect(
      repaired.state.liveData.plays.currentPlay!.playEvents.slice(0, 2)
    ).deep.equals(events)
    expect(repaired.state.liveData.linescore).includes({ balls: 1, strikes: 1 })
  })
  for (const played of [false, true])
    for (const top of [false, true])
      for (const explicitFirst of [false, true])
        it(`tracks ordinary roster pinch hits during pitcher setup: played=${played}, top=${top}, chain=${explicitFirst}`, function () {
          let state = initial().session
          const side = top ? 'away' : 'home'
          const original = top ? 1 : 10
          const first = top ? 9 : 18
          const second = top ? 8 : 17
          state.liveData.boxscore.teams[side].battingOrder.splice(-2)
          const act = (action: Parameters<typeof applyAction>[1]): void => {
            const result = applyAction(state, action)
            expect(result.problems).deep.equals([])
            state = result.state
          }
          if (played) {
            for (let i = 0; i < 3; i++) act({ type: 'pitch', call: 'S' })
            act({ type: 'gameFlow', kind: 'closePlay' })
          }
          if (top) {
            const bottom = overrideActions(
              state,
              overrideHalf(state, overrideOf(state), false)
            )
            if ('error' in bottom) throw new Error(bottom.error)
            bottom.actions.forEach(act)
          }
          const prepared = overrideActions(state, {
            ...overrideHalf(state, overrideOf(state), top),
            batter: original,
            batterIndex: 0,
            strikes: 2,
            ...(explicitFirst ? { pinchHitter: first } : {})
          })
          if ('error' in prepared) throw new Error(prepared.error)
          prepared.actions.forEach(act)
          const setup = setupOf(state)
          setup.sides[side].battingOrder[0] = second
          act({ type: 'lineup', kind: 'roster', setup })
          if (explicitFirst)
            expect(
              state.pendingLineupEvents
                ?.filter(event => event.position === 'PH')
                .map(event => event.battingOrder)
            ).deep.equals(['101', '102'])
          state = asGameState(JSON.parse(JSON.stringify(state)))
          const repaired = setupOf(state)
          repaired.sides[top ? 'home' : 'away'].defense.P = top ? 10 : 1
          act({ type: 'lineup', kind: 'roster', setup: repaired })
          act({ type: 'pitch', call: 'S' })
          act({ type: 'gameFlow', kind: 'closePlay' })
          const play = state.liveData.plays.allPlays.at(-1)!
          const charged = played || explicitFirst ? original : second
          expect(strikeoutBatter(play)).equals(charged)
          expect(statLines([play]).batting[charged]).includes({
            pa: 1,
            ab: 1,
            k: 1
          })
          expect(state.overrideLineupSetup).equals(undefined)
          expect(state.overridePlayStarted).equals(undefined)
        })
  for (const pinch of [false, true])
    it(`keeps a same-half selected turn when repairing the initial pitcher: pinch=${pinch}`, function () {
      let state = initial()
      state.session.liveData.boxscore.teams.away.battingOrder.pop()
      const setup = setupOf(state.session)
      const pitcher = setup.sides.home.defense.P
      setup.sides.home.defense.P = null
      state.session = applyAction(state.session, {
        type: 'lineup',
        kind: 'roster',
        setup
      }).state
      state = scoringReducer(state, {
        type: 'OVERRIDE',
        draft: {
          ...overrideOf(state.session),
          batter: 5,
          batterIndex: 4,
          ...(pinch ? { pinchHitter: 9 } : {})
        }
      })
      const repaired = setupOf(state.session)
      repaired.sides.home.defense.P = pitcher
      const result = applyAction(
        asGameState(JSON.parse(JSON.stringify(state.session))),
        { type: 'lineup', kind: 'roster', setup: repaired }
      )
      expect(result.problems).deep.equals([])
      expect(result.state.liveData.boxscore.teams.away.battingIndex).equals(4)
      expect(result.state.liveData.linescore.offense.batter?.id).equals(
        pinch ? 9 : 5
      )
    })
  it('handles empty and occupied due slots without choosing an invalid batter', function () {
    const state = initial().session
    state.liveData.linescore.offense.first = { id: 1, fullName: 'Mookie Betts' }
    expect(overrideHalf(state, overrideOf(state), true).batter).equals(null)
    state.liveData.boxscore.teams.home.battingOrder = []
    expect(overrideHalf(state, overrideOf(state), false).batter).equals(null)
  })
})

describe('reviewed override setup corrections', function () {
  it('keeps mid-count score edits out of tiebreaker setup and allows explicit base corrections', function () {
    let state = initial()
    state = scoringReducer(state, {
      type: 'OVERRIDE',
      draft: { ...overrideOf(state.session), inning: 4 }
    })
    state.session = applyAction(state.session, {
      type: 'pitch',
      call: 'B'
    }).state
    const original = overrideOf(state.session)
    state = scoringReducer(state, {
      type: 'OVERRIDE',
      draft: { ...original, batterIndex: 0, awayScore: 1 }
    })
    expect(tiebreakerSetupError(state.session)).includes('before the inning')
    const placed = scoringReducer(state, {
      type: 'OVERRIDE',
      draft: { ...overrideOf(state.session), bases: [2, null, null] }
    })
    expect(baseIds(placed.session)).deep.equals([2, null, null])
    expect(tiebreakerSetupError(placed.session)).includes('before the inning')
    expect(placed.session.liveData.linescore.defense.P?.id).equals(
      original.pitcher
    )
  })
  it('keeps score-only pregame corrections as opening lineup edits', function () {
    let state = initial()
    state.session.liveData.boxscore.teams.away.battingOrder.pop()
    state = scoringReducer(state, {
      type: 'OVERRIDE',
      draft: { ...overrideOf(state.session), batterIndex: 0, awayScore: 1 }
    })
    expect(state.session.overrideLineupSetup).equals(undefined)
    const setup = setupOf(state.session)
    setup.sides.away.battingOrder[2] = 9
    const edited = applyAction(state.session, {
      type: 'lineup',
      kind: 'roster',
      setup
    })
    expect(edited.problems).deep.equals([])
    expect(edited.state.liveData.plays.currentPlay?.playEvents).deep.equals([])
    expect(edited.state.liveData.boxscore.teams.away.battingIndex).equals(0)
  })
  for (const incoming of [1, 2]) {
    it(`distinguishes restoring pitcher 1 from replacing him with ${incoming}, including saved state`, function () {
      let state = initial()
      state.session = applyAction(state.session, {
        type: 'pitch',
        call: 'B'
      }).state
      state = scoringReducer(state, {
        type: 'OVERRIDE',
        draft: overrideHalf(state.session, overrideOf(state.session), false)
      })
      const saved = asGameState(JSON.parse(JSON.stringify(state.session)))
      const setup = setupOf(saved)
      for (const key of Object.keys(setup.sides.away.defense) as Array<
        keyof typeof setup.sides.away.defense
      >)
        if (setup.sides.away.defense[key] === incoming)
          setup.sides.away.defense[key] = null
      setup.sides.away.defense.P = incoming
      const repaired = applyAction(saved, {
        type: 'lineup',
        kind: 'roster',
        setup
      })
      expect(repaired.problems).deep.equals([])
      const events =
        repaired.state.liveData.plays.currentPlay!.playEvents.filter(
          event => event.details.code === 'pitching_substitution'
        )
      expect(events).length(incoming === 1 ? 0 : 1)
      if (incoming !== 1) expect(events[0].replacedPlayer?.id).equals(1)
      expect(repaired.state.overridePitchers?.away).equals(undefined)
    })
  }
  it('uses the same roster validation for the override preview and commit', function () {
    let state = initial()
    state = scoringReducer(state, {
      type: 'OVERRIDE',
      draft: { ...overrideOf(state.session), batter: 5, batterIndex: 4 }
    })
    const setup = setupOf(state.session)
    setup.sides.away.battingOrder = []
    const result = applyAction(state.session, {
      type: 'lineup',
      kind: 'roster',
      setup
    })
    expect(rosterError(state.session, setup)).equals(
      result.problems[0]?.message
    )
    expect(result.problems).deep.equals([])
    expect(result.state.liveData.boxscore.teams.away.battingIndex).equals(0)
    const valid = setupOf(state.session)
    expect(rosterError(state.session, valid)).equals(undefined)
    const repaired = applyAction(state.session, {
      type: 'lineup',
      kind: 'roster',
      setup: valid
    })
    expect(repaired.state.liveData.boxscore.teams.away.battingIndex).equals(4)
  })
})

describe('runner corrections and team-scoped pending substitutions', function () {
  it('places correction runners without tiebreaker events or error charges, and replays and undoes them', function () {
    const start = initial()
    const corrected = scoringReducer(start, {
      type: 'OVERRIDE',
      draft: { ...overrideOf(start.session), balls: 2, bases: [null, 2, null] }
    })
    const placed = scoringReducer(corrected, {
      type: 'OVERRIDE',
      draft: { ...overrideOf(corrected.session), bases: [5, 2, null] }
    })
    expect(baseIds(placed.session)).deep.equals([5, 2, null])
    expect(
      placed.session.liveData.linescore.offense.reachedOnError?.first
    ).equals(false)
    expect(placed.session.liveData.plays.currentPlay!.playEvents).deep.equals(
      []
    )
    expect(scoringReducer(placed, { type: 'UNDO' }).session).deep.equals(
      corrected.session
    )
    let replayed = start.session
    for (const action of JSON.parse(JSON.stringify(placed.log))) {
      const result = applyAction(replayed, action)
      expect(result.problems).deep.equals([])
      replayed = result.state
    }
    expect(baseIds(replayed)).deep.equals([5, 2, null])
    expect(replayed.liveData.linescore.offense.reachedOnError?.first).equals(
      false
    )
    const moved = scoringReducer(placed, {
      type: 'OVERRIDE',
      draft: { ...overrideOf(placed.session), bases: [null, 5, null] }
    })
    expect(baseIds(moved.session)).deep.equals([null, 5, null])
    const cleared = scoringReducer(moved, {
      type: 'OVERRIDE',
      draft: { ...overrideOf(moved.session), bases: [null, null, null] }
    })
    expect(baseIds(cleared.session)).deep.equals([null, null, null])
    expect(scoringReducer(cleared, { type: 'UNDO' }).session).deep.equals(
      moved.session
    )
  })
  it('preserves a selected pregame slot without fabricating an ordinary roster substitution', function () {
    let state = initial()
    state.session.liveData.boxscore.teams.away.battingOrder.pop()
    state = scoringReducer(state, {
      type: 'OVERRIDE',
      draft: { ...overrideOf(state.session), batter: 5, batterIndex: 4 }
    })
    const setup = setupOf(state.session)
    setup.sides.away.battingOrder[2] = 9
    expect(rosterError(state.session, setup)).equals(undefined)
    const edited = applyAction(state.session, {
      type: 'lineup',
      kind: 'roster',
      setup
    })
    expect(edited.problems).deep.equals([])
    expect(edited.state.liveData.plays.currentPlay!.playEvents).deep.equals([])
    expect(edited.state.liveData.boxscore.teams.away.battingIndex).equals(4)
  })
  it('holds the home pinch hit for a home appearance and includes it in a final document if the game ends first', function () {
    const start = initial()
    start.session.liveData.boxscore.teams.home.battingOrder.pop()
    let state = scoringReducer(start, {
      type: 'OVERRIDE',
      draft: {
        ...overrideHalf(start.session, overrideOf(start.session), false),
        pinchHitter: 18
      }
    })
    state = scoringReducer(state, {
      type: 'OVERRIDE',
      draft: overrideHalf(state.session, overrideOf(state.session), true)
    })
    const setup = setupOf(state.session)
    setup.sides.home.defense.RF = null
    setup.sides.home.defense.P = 18
    let repaired = applyAction(state.session, {
      type: 'lineup',
      kind: 'roster',
      setup
    }).state
    expect(
      repaired.pendingLineupEvents!.some(
        event => event.player.id === 18 && event.position === 'PH'
      )
    ).equals(true)
    expect(
      repaired.liveData.plays.currentPlay!.playEvents.some(
        event => event.position === 'PH'
      )
    ).equals(false)
    repaired = asGameState(JSON.parse(JSON.stringify(repaired)))
    let ended = repaired
    for (const action of [
      ...Array.from({ length: 3 }, () => ({
        type: 'pitch' as const,
        call: 'S' as const
      })),
      { type: 'gameFlow' as const, kind: 'closePlay' as const },
      { type: 'gameFlow' as const, kind: 'endGame' as const }
    ]) {
      const result = applyAction(ended, action)
      expect(result.problems).deep.equals([])
      ended = result.state
    }
    expect(ended.final).equals(true)
    const final = finalDocumentOf(ended, {
      setupBefore: setupOf(repaired),
      actions: [{ type: 'gameFlow', kind: 'endGame' }]
    })
    expect(final).nested.property(
      'playEvents[0].details.eventType',
      'offensive_substitution'
    )
    const bottom = overrideActions(
      repaired,
      overrideHalf(repaired, overrideOf(repaired), false)
    )
    if ('error' in bottom) throw new Error(bottom.error)
    for (const action of bottom.actions)
      repaired = applyAction(repaired, action).state
    const defense = setupOf(repaired)
    defense.sides.away.defense.P = 1
    repaired = applyAction(repaired, {
      type: 'lineup',
      kind: 'roster',
      setup: defense
    }).state
    expect(repaired.liveData.plays.currentPlay!.about.halfInning).equals(
      'bottom'
    )
    expect(
      repaired.liveData.plays.currentPlay!.playEvents.filter(
        event => event.position === 'PH'
      )
    ).length(1)
    expect(repaired.pendingLineupEvents).equals(undefined)
  })
})

describe('override preview follows the scoring transaction', function () {
  it('keeps tiebreaker scoring after changing into extra innings and assigning the pitcher', function () {
    const bottom = applyAction(initial().session, {
      type: 'gameFlow',
      kind: 'override',
      inning: 9,
      top: false,
      batter: 10,
      pitcher: 1,
      awayScore: 3,
      homeScore: 3
    })
    expect(bottom.problems).deep.equals([])
    let state = initialScoringState(bottom.state)
    state = scoringReducer(state, {
      type: 'OVERRIDE',
      draft: {
        ...overrideHalf(state.session, overrideOf(state.session), true),
        inning: 10
      }
    })
    const roster = structuredClone(state.session)
    roster.liveData.boxscore.teams.home.defense.P = 10
    state = scoringReducer(state, { type: 'ROSTER', draft: roster })
    const pitcher = halfPitcher(state.session)
    expect(pitcher?.id).equals(10)
    const placed = scoringReducer(state, {
      type: 'MORE',
      input: { action: 'Place a Runner (Tiebreaker)', playerId: 5, base: 2 }
    })
    const offense = placed.session.liveData.linescore.offense
    expect(offense.second?.id).equals(5)
    expect(offense.reachedOnError?.second).equals(true)
    expect(offense.responsiblePitcher?.second).deep.equals(pitcher)
    expect(
      placed.session.liveData.plays.currentPlay!.playEvents.map(
        event => event.details.code
      )
    ).includes('placed_runner')
    expect(
      JSON.parse(
        JSON.stringify(scoringReducer(placed, { type: 'UNDO' }).session)
      )
    ).deep.equals(JSON.parse(JSON.stringify(state.session)))
  })
  it('reports read-only and active-play refusals before Apply, without mutating the screen', function () {
    const state = initial()
    const draft = overrideOf(state.session)
    expect(overrideProblem(state, draft)).equals(undefined)
    const before = JSON.stringify(state)
    expect(overrideProblem({ ...state, readOnly: true }, draft)).equals(
      'Scoring is read-only'
    )
    expect(
      overrideProblem({ ...state, phase: 'runnerDecision' }, draft)
    ).includes('Finish the current play')
    expect(JSON.stringify(state)).equals(before)
    expect(
      scoringReducer({ ...state, readOnly: true }, { type: 'OVERRIDE', draft })
        .log
    ).deep.equals(state.log)
  })
  it('preserves real tiebreaker event and error treatment after an extra-inning score-only edit', function () {
    let state = initial()
    const result = applyAction(state.session, {
      type: 'gameFlow',
      kind: 'override',
      inning: 10
    })
    expect(result.problems).deep.equals([])
    state = initialScoringState(result.state)
    const draft = { ...overrideOf(state.session), awayScore: 1 }
    expect(overrideProblem(state, draft)).equals(undefined)
    state = scoringReducer(state, { type: 'OVERRIDE', draft })
    const placed = scoringReducer(state, {
      type: 'MORE',
      input: { action: 'Place a Runner (Tiebreaker)', playerId: 5, base: 2 }
    })
    expect(
      placed.session.liveData.linescore.offense.reachedOnError?.second
    ).equals(true)
    expect(
      placed.session.liveData.plays.currentPlay!.playEvents.map(
        event => event.details.code
      )
    ).deep.equals(['placed_runner'])
  })
})
