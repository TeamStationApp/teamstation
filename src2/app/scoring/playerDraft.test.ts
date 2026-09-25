import { expect } from 'chai'
import { describe, it } from 'mocha'

import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  addPlayerDraft,
  emptyPlayerDraft,
  PLAYER_POSITIONS,
  playerDraftError
} from './playerDraft'
import { applyRosterDraft } from './scoringEdits'
import { initialScoringState, scoringReducer } from './scoringMachine'

describe('local player entry', function () {
  it('validates names and jersey without mutating a draft on failure', function () {
    const session = createDevelopmentSession(gameFixture, [], [])
    const before = JSON.stringify(session)
    const draft = emptyPlayerDraft()
    expect(draft).includes({ bats: 'right', throws: 'right' })
    expect(draft.positions).deep.equals([])
    expect(playerDraftError(draft)).equals('Enter a player name.')
    expect(() => addPlayerDraft(session, 'home', draft)).throws(
      'Enter a player name'
    )
    expect(JSON.stringify(session)).equals(before)
    expect(playerDraftError({ ...draft, firstName: 'A', jersey: '3x' })).equals(
      'Use digits for the jersey number.'
    )
    expect(playerDraftError({ ...draft, lastName: 'Only' })).equals(undefined)
  })
  it('preserves names, leading zeros, handedness and optional preferences through save and undo', function () {
    const session = createDevelopmentSession(gameFixture, [], [])
    const state = initialScoringState(session)
    const before = JSON.stringify(session.liveData.boxscore)
    for (const side of ['away', 'home'] as const)
      for (const bats of ['left', 'switch', 'right'] as const) {
        const id = addPlayerDraft(session, side, {
          ...emptyPlayerDraft(),
          firstName: ' Alex ',
          lastName: ' Lee ',
          jersey: ' 00 ',
          bats,
          throws: 'left',
          positions: [...PLAYER_POSITIONS, 'bad', 'P']
        })
        expect(session.gameData.players[id]).includes({
          firstName: 'Alex',
          lastName: 'Lee',
          fullName: 'Alex Lee',
          jersey: '00',
          bats,
          throws: 'left',
          local: true,
          teamId: session.gameData.teams[side].id
        })
        expect(session.gameData.players[id].positions).deep.equals(
          PLAYER_POSITIONS
        )
        expect(session.liveData.boxscore.teams[side].battingOrder).not.includes(
          id
        )
        expect(
          Object.values(session.liveData.boxscore.teams[side].defense)
        ).not.includes(id)
      }
    expect(JSON.stringify(session.liveData.boxscore)).not.equals(before)
    expect(applyRosterDraft(state, session).error).equals(undefined)
    const saved = scoringReducer(state, { type: 'ROSTER', draft: session })
    expect(Object.keys(saved.session.gameData.players)).length(24)
    expect(scoringReducer(saved, { type: 'UNDO' }).session).deep.equals(
      state.session
    )
  })
})
