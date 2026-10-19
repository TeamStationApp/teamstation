import { expect } from 'chai'
import { describe, it } from 'mocha'

import { rosterError } from '../../common/scoring/rules'
import { setupOf } from '../../common/scoring/state'
import { scoringSession } from '../../test/scoringSession'
import { fieldPlayersFor } from './fieldAdapter'
import { gameFixture } from './isUnscoredGame.test'
import {
  addPlayerDraft,
  addRosteredPlayer,
  draftOfLocalPlayer,
  editLocalPlayerDraft,
  emptyPlayerDraft,
  PLAYER_POSITIONS,
  playerDraftError,
  rosterPlayerBody
} from './playerDraft'
import { initialScoringState, scoringReducer } from './scoringMachine'

describe('local player entry', function () {
  it('renders the current local batter’s edited handedness when the rosters are saved before pitching', function () {
    const session = scoringSession(gameFixture)
    const state = initialScoringState(session)
    const id = session.liveData.plays.currentPlay!.matchup.batter.id
    const draft = structuredClone(session)
    editLocalPlayerDraft(draft, 'away', id, {
      ...draftOfLocalPlayer(draft.gameData.players[id]),
      bats: 'left'
    })
    const saved = scoringReducer(state, { type: 'ROSTER', draft })
    expect(
      saved.session.liveData.plays.currentPlay!.matchup.batSide.code
    ).equals('L')
    expect(
      fieldPlayersFor(saved.session).find(player => player.batting === true)
        ?.batSide
    ).equals('L')
    expect(scoringReducer(saved, { type: 'UNDO' }).session).deep.equals(
      state.session
    )
  })
  it('corrects a named placeholder in place while preserving its lineup, defense and Undo identity', function () {
    const session = scoringSession(gameFixture)
    const id = session.liveData.boxscore.teams.away.players[0]
    const before = JSON.stringify(session.liveData.boxscore)
    const identities = JSON.stringify(session.meta.tagOrder)
    const state = initialScoringState(session)
    const edited = structuredClone(session)
    const player = draftOfLocalPlayer(edited.gameData.players[id])
    editLocalPlayerDraft(edited, 'away', id, {
      ...player,
      firstName: 'Jose',
      lastName: 'Altuve',
      jersey: '00',
      bats: 'switch',
      throws: 'left',
      positions: ['DH', 'P', 'DH', 'bad']
    })
    expect(edited.gameData.players[id]).includes({
      id,
      userId: id,
      fullName: 'Jose Altuve',
      jersey: '00',
      bats: 'switch',
      throws: 'left'
    })
    expect(edited.gameData.players[id].positions).deep.equals(['P', 'DH'])
    expect(JSON.stringify(edited.liveData.boxscore)).equals(before)
    expect(JSON.stringify(edited.meta.tagOrder)).equals(identities)
    const saved = scoringReducer(state, { type: 'ROSTER', draft: edited })
    expect(saved.session.gameData.players[id].fullName).equals('Jose Altuve')
    const undone = scoringReducer(saved, { type: 'UNDO' })
    expect(undone.session.gameData.players[id]).deep.equals(
      session.gameData.players[id]
    )
    const snapshot = JSON.stringify(edited)
    expect(() => {
      editLocalPlayerDraft(edited, 'home', id, player)
    }).throws('not on the roster')
    expect(() => {
      editLocalPlayerDraft(edited, 'away', 99999, player)
    }).throws('not on the roster')
    expect(() => {
      editLocalPlayerDraft(edited, 'away', id, {
        ...player,
        firstName: '',
        lastName: ''
      })
    }).throws('Enter a player name')
    expect(JSON.stringify(edited)).equals(snapshot)
    edited.gameData.players[id].local = false
    expect(() => {
      editLocalPlayerDraft(edited, 'away', id, player)
    }).throws('not on the roster')
  })

  it('starts legacy game-only names and unknown throwing hands without inventing a hand', function () {
    const session = scoringSession(gameFixture)
    const player =
      session.gameData.players[session.liveData.boxscore.teams.away.players[0]]
    player.fullName = 'Jose Ramirez'
    delete player.firstName
    delete player.lastName
    player.throws = null
    const draft = draftOfLocalPlayer(player)
    expect(draft).includes({
      firstName: 'Jose',
      lastName: 'Ramirez',
      throws: null
    })
    expect(draft.positions).not.equals(player.positions)
  })
  it('validates names and jersey without mutating a draft on failure', function () {
    const session = scoringSession(gameFixture)
    const before = JSON.stringify(session)
    const draft = emptyPlayerDraft()
    expect(draft).includes({ bats: 'right', throws: 'right' })
    expect(draft.positions).deep.equals([])
    expect(playerDraftError(draft)).equals('Enter a player name.')
    expect(() => addPlayerDraft(session, 'home', draft, 9000000)).throws(
      'Enter a player name'
    )
    expect(JSON.stringify(session)).equals(before)
    expect(playerDraftError({ ...draft, firstName: 'A', jersey: '3x' })).equals(
      'Use digits for the jersey number.'
    )
    expect(playerDraftError({ ...draft, lastName: 'Only' })).equals(undefined)
  })
  it('preserves names, leading zeros, handedness and optional preferences through save and undo', function () {
    const session = scoringSession(gameFixture)
    const state = initialScoringState(session)
    const before = JSON.stringify(session.liveData.boxscore)
    for (const side of ['away', 'home'] as const)
      for (const bats of ['left', 'switch', 'right'] as const) {
        const id = addPlayerDraft(
          session,
          side,
          {
            ...emptyPlayerDraft(),
            firstName: ' Alex ',
            lastName: ' Lee ',
            jersey: ' 00 ',
            bats,
            throws: 'left',
            positions: [...PLAYER_POSITIONS, 'bad', 'P']
          },
          9000000 + session.meta.tagOrder.length
        )
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
    expect(rosterError(state.session, setupOf(session))).equals(undefined)
    const saved = scoringReducer(state, { type: 'ROSTER', draft: session })
    expect(Object.keys(saved.session.gameData.players)).length(24)
    expect(scoringReducer(saved, { type: 'UNDO' }).session).deep.equals(
      state.session
    )
  })

  it('adds a created roster player under their user id, once', function () {
    const session = scoringSession(gameFixture)
    const draft = {
      ...emptyPlayerDraft(),
      firstName: 'Cliff',
      lastName: 'Lee',
      jersey: '7',
      positions: ['SS', 'EH']
    }
    expect(rosterPlayerBody(draft).positions).deep.equals(['SS'])
    const entry = { userId: 8800001, shortName: 'Cliff L' }
    const id = addRosteredPlayer(session, 'home', entry, draft)
    const player = session.gameData.players[id]
    expect(player.userId).equals(8800001)
    expect(player.local).equals(false)
    expect(player.fullName).equals('Cliff L')
    expect(player.positions).deep.equals(['SS', 'EH'])
    expect(
      session.liveData.boxscore.teams.home.players.filter(row => row === id)
    ).has.length(1)
    expect(addRosteredPlayer(session, 'home', entry, draft)).equals(id)
    expect(
      session.liveData.boxscore.teams.home.players.filter(row => row === id)
    ).has.length(1)
  })
})
