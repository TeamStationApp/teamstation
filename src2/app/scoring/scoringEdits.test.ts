import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  addDevelopmentPlayer,
  createDevelopmentSession
} from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  applyOverrideDraft,
  applyRosterDraft,
  overrideDraft,
  validateRoster
} from './scoringEdits'
import {
  copyState,
  initialScoringState,
  scoringReducer
} from './scoringMachine'
import { playerRef, startAppearance } from './scoringSelectors'
import { POSITIONS } from './scoringTypes'
const initial = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(createDevelopmentSession(gameFixture, [], []))
describe('atomic scoring edits', function () {
  it('preserves batter identity, count and pitches through reordered rosters and pitcher replacement', function () {
    const state = scoringReducer(initial(), { type: 'PITCH', kind: 'ball' })
    const draft = copyState(state.session)
    draft.liveData.boxscore.teams.away.battingOrder.reverse()
    const defense = draft.liveData.boxscore.teams.home.defense
    const catcher = defense.C!
    defense.C = defense.P
    defense.P = catcher
    const next = scoringReducer(state, { type: 'ROSTER', draft })
    expect(next.session.liveData.boxscore.teams.away.battingIndex).equals(8)
    expect(next.session.liveData.plays.currentPlay?.playEvents).deep.equals(
      state.session.liveData.plays.currentPlay?.playEvents
    )
    expect(next.session.liveData.linescore.balls).equals(1)
    expect(next.session.liveData.plays.currentPlay?.matchup.pitcher.id).equals(
      catcher
    )
    expect(scoringReducer(next, { type: 'UNDO' }).session).deep.equals(
      state.session
    )
  })
  it('chooses a surviving eligible batter in old cyclic order and validates every roster membership rule', function () {
    const state = initial()
    const draft = copyState(state.session)
    draft.liveData.boxscore.teams.away.battingOrder = [4, 3]
    state.session.liveData.linescore.offense.first = playerRef(state.session, 3)
    expect(
      applyRosterDraft(state, draft).session?.liveData.linescore.offense.batter
        ?.id
    ).equals(4)
    draft.liveData.boxscore.teams.away.battingOrder = [3]
    expect(applyRosterDraft(state, draft).error).includes('not already on base')
    const cases = [
      (d: typeof draft) => {
        d.liveData.boxscore.teams.away.battingOrder = []
      },
      (d: typeof draft) => {
        d.liveData.boxscore.teams.away.battingOrder = [1, 1]
      },
      (d: typeof draft) => {
        d.liveData.boxscore.teams.away.battingOrder = [10]
      },
      (d: typeof draft) => {
        d.liveData.boxscore.teams.away.defense.P = null
      },
      (d: typeof draft) => {
        d.liveData.boxscore.teams.away.defense.C =
          d.liveData.boxscore.teams.away.defense.P
      },
      (d: typeof draft) => {
        d.liveData.boxscore.teams.home.defense.P = 1
      }
    ]
    for (const change of cases) {
      const bad = copyState(initial().session)
      change(bad)
      expect(validateRoster(bad)).is.a('string')
      expect(applyRosterDraft(state, bad).error).is.a('string')
    }
    const newDraft = copyState(state.session)
    const replacement = addDevelopmentPlayer(newDraft, 'away', 'New player')
    newDraft.liveData.boxscore.teams.away.battingOrder = [replacement]
    newDraft.gameData.players[replacement].bats = 'left'
    expect(
      applyRosterDraft(state, newDraft).session?.liveData.plays.currentPlay
        ?.matchup.batSide.code
    ).equals('L')
  })
  it('requires an explicit next batter when all short-lineup players are on base, and undoes repair atomically', function () {
    const state = initial()
    const session = state.session
    session.liveData.boxscore.teams.away.battingOrder = [1]
    session.liveData.linescore.offense.first = playerRef(session, 1)
    state.awaitingBatter = startAppearance(session)
    state.phase = 'awaitingBatter'
    const draft = copyState(session)
    const newId = addDevelopmentPlayer(draft, 'away', 'Relief batter')
    draft.liveData.boxscore.teams.away.battingOrder.push(newId)
    expect(applyRosterDraft(state, draft).error).is.a('string')
    expect(applyRosterDraft(state, draft, 1).error).is.a('string')
    const repaired = scoringReducer(state, {
      type: 'ROSTER',
      draft,
      nextBatter: newId
    })
    expect(repaired.phase).equals('ready')
    expect(repaired.session.liveData.linescore.offense.batter?.id).equals(newId)
    expect(scoringReducer(repaired, { type: 'UNDO' }).phase).equals(
      'awaitingBatter'
    )
  })
  it('validates numeric overrides and rejects duplicate, foreign and batter base occupants', function () {
    const state = initial()
    const good = overrideDraft(state.session)
    for (const [key, value] of [
      ['inning', 0],
      ['inning', 1.5],
      ['awayScore', -1],
      ['homeScore', NaN],
      ['balls', 4],
      ['strikes', 3],
      ['outs', 3]
    ] as const)
      expect(applyOverrideDraft(state, { ...good, [key]: value }).error).is.a(
        'string'
      )
    for (const batter of [null, 10, 999])
      expect(applyOverrideDraft(state, { ...good, batter }).error).includes(
        'batter'
      )
    for (const pitcher of [null, 1, 999])
      expect(applyOverrideDraft(state, { ...good, pitcher }).error).includes(
        'pitcher'
      )
    for (const bases of [[1, null, null], [2, 2, null], [10, null, null], []])
      expect(applyOverrideDraft(state, { ...good, bases }).error).includes(
        'Bases'
      )
    expect(
      scoringReducer(state, { type: 'OVERRIDE', draft: { ...good, balls: 4 } })
    ).equals(state)
  })
  it('changes the half, pitcher, batter/index and count together without duplicate defenders', function () {
    const state = initial()
    const draft = {
      ...overrideDraft(state.session),
      top: false,
      inning: 12,
      batter: 12,
      pitcher: 2,
      bases: [11, null, null],
      balls: 3,
      strikes: 2,
      outs: 2,
      awayScore: 4,
      homeScore: 2
    }
    const next = scoringReducer(state, { type: 'OVERRIDE', draft })
    const line = next.session.liveData.linescore
    expect(line.currentInningOrdinal).equals('12th')
    expect(line.inningState).equals('Bottom')
    expect(next.session.liveData.boxscore.teams.home.battingIndex).equals(2)
    expect(
      POSITIONS.filter(position => line.defense[position]?.id === 2)
    ).deep.equals(['P'])
    expect(next.session.liveData.plays.currentPlay?.count).deep.equals({
      balls: 3,
      strikes: 2,
      outs: 2
    })
    expect(scoringReducer(next, { type: 'UNDO' }).session).deep.equals(
      state.session
    )
    const modified = scoringReducer(next, {
      type: 'OVERRIDE',
      draft: { ...draft, batter: 13 }
    })
    expect(
      modified.session.liveData.plays.currentPlay?.matchup.batter.id
    ).equals(13)
    const pending = { ...next, phase: 'trajectory' as const }
    expect(scoringReducer(pending, { type: 'OVERRIDE', draft })).equals(pending)
  })
})
