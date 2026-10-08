import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  overrideError,
  overrideOf as overrideDraft,
  rosterError,
  validateRoster
} from '../../common/scoring/rules'
import { setupOf } from '../../common/scoring/state'
import {
  addDevelopmentPlayer,
  createDevelopmentSession
} from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  copyState,
  initialScoringState,
  scoringReducer
} from './scoringMachine'
import { playerRef } from './scoringSelectors'
import { POSITIONS } from './scoringTypes'
const initial = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(createDevelopmentSession(gameFixture, [], []))
/** What taking a roster would do: the error, or the game it leaves. */
function applyRosterDraft(
  state: ReturnType<typeof initial>,
  draft: ReturnType<typeof initial>['session'],
  nextBatter?: number
): { error?: string; session?: ReturnType<typeof initial>['session'] } {
  const error = rosterError(state.session, setupOf(draft), nextBatter)
  if (error != null) return { error }
  return {
    session: scoringReducer(state, { type: 'ROSTER', draft, nextBatter })
      .session
  }
}
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
    // The pitch stays; the changes follow it as the play's lineup events.
    const events = next.session.liveData.plays.currentPlay!.playEvents
    expect(events.slice(0, 1)).deep.equals(
      state.session.liveData.plays.currentPlay?.playEvents
    )
    expect(
      events.slice(1).map(event => [event.isSubstitution, event.details.code])
    ).deep.equals([
      [true, 'pitching_substitution'],
      [true, 'ts_batting_order'],
      [true, 'defensive_switch']
    ])
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
    for (const [index, change] of cases.entries()) {
      const bad = copyState(initial().session)
      change(bad)
      expect(validateRoster(bad)).is.a('string')
      if (index === 3)
        expect(applyRosterDraft(state, bad).error).equals(undefined)
      else expect(applyRosterDraft(state, bad).error).is.a('string')
    }
    // With nobody on base, so the new man bats rather than running for a
    // runner the new order leaves out.
    const empty = initial()
    const newDraft = copyState(empty.session)
    const replacement = addDevelopmentPlayer(newDraft, 'away', 'New player')
    newDraft.liveData.boxscore.teams.away.battingOrder = [replacement]
    newDraft.gameData.players[replacement].bats = 'left'
    expect(
      applyRosterDraft(empty, newDraft).session?.liveData.plays.currentPlay
        ?.matchup.batSide.code
    ).equals('L')
  })
  it('requires an explicit next batter when all short-lineup players are on base, and undoes repair atomically', function () {
    const state = initial()
    const session = state.session
    session.liveData.boxscore.teams.away.battingOrder = [1]
    session.liveData.linescore.offense.first = playerRef(session, 1)
    session.liveData.plays.currentPlay = null
    session.liveData.linescore.offense.batter = null
    state.session.awaitingBatter = {
      teamId: session.gameData.teams.away.id,
      dueIndex: 0,
      duePlayerId: 1
    }
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
      expect(overrideError(state.session, { ...good, [key]: value })).is.a(
        'string'
      )
    for (const batter of [null, 10, 999])
      expect(overrideError(state.session, { ...good, batter })).includes(
        'batter'
      )
    for (const pitcher of [null, 1, 999])
      expect(overrideError(state.session, { ...good, pitcher })).includes(
        'pitcher'
      )
    for (const bases of [[1, null, null], [2, 2, null], [10, null, null], []])
      expect(overrideError(state.session, { ...good, bases })).includes('Bases')
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
