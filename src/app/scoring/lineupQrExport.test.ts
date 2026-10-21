import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry, type RosterEntry } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { decodeLineupQr, encodeLineupQr } from './lineupQrCodec'
import { lineupQrOf } from './lineupQrExport'
import { packGameId, packPlayerId, packTeamId, unpackId } from './lineupQrIds'
import { applyLineupQr } from './lineupQrImport'
import { addPlayerDraft, emptyPlayerDraft } from './playerDraft'
import type { Position, ScoringSessionState } from './scoringTypes'

const PEOPLE = [
  ['Mookie', 'Betts', '1'],
  ['Mike', 'Trout', '2'],
  ['Shohei', 'Ohtani', '3'],
  ['Aaron', 'Judge', '4'],
  ['Bryce', 'Harper', '5'],
  ['Freddie', 'Freeman', '6'],
  ['Francisco', 'Lindor', '7'],
  ['Juan', 'Soto', '12'],
  ['Bobby', 'Witt', '99'],
  ['Julio', 'Rodriguez', '100']
] as const
const ROSTER: RosterEntry[] = PEOPLE.map(([first, last, jersey], k) =>
  asRosterEntry({
    userId: userIdOfGumbo(100 + k),
    gumboId: 100 + k,
    shortName: `${first} ${last[0]}`,
    jersey,
    bats: null,
    throws: null,
    positions: [],
    isPlayer: true,
    role: 'member',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null
  })
)
/** All ten bat; P C 1B 2B SS 3B LF CF RF are the first nine. */
const session = (): ScoringSessionState =>
  createDevelopmentSession(gameFixture, ROSTER, [])
const codes = (state: ScoringSessionState): number[] =>
  lineupQrOf(state, 'away').h.map(player => player.p)

describe('lineup QR export', function () {
  it('gives each batter the code of his place on the field', function () {
    const state = session()
    const team = state.liveData.boxscore.teams.away
    team.battingOrder = team.battingOrder.slice(0, 9)
    expect(codes(state)).deep.equals([4, 5, 1, 2, 10, 3, 7, 6, 8])
    const lineup = lineupQrOf(state, 'away')
    expect(lineup.n).deep.equals([])
    expect(lineup.h[0]).deep.include({ f: 'Mookie', l: 'B', n: '1' })
  })

  it('makes a batter with no place the DH of a fielder who does not bat', function () {
    const state = session()
    const team = state.liveData.boxscore.teams.away
    // The pitcher (Mookie) leaves the order; Julio bats with no place.
    team.battingOrder = team.battingOrder.slice(1)
    const lineup = lineupQrOf(state, 'away')
    expect(lineup.h.map(player => player.p).at(-1)).equals(12)
    expect(lineup.n.map(player => [player.f, player.p])).deep.equals([
      ['Mookie', 104]
    ])
  })

  it('makes the batters with no place EHs when nobody fields without batting', function () {
    const state = session()
    const team = state.liveData.boxscore.teams.away
    team.defense.RF = null
    expect(codes(state).slice(-2)).deep.equals([11, 11])
  })

  it('names one DH per fielder who does not bat, then EHs', function () {
    const state = session()
    const team = state.liveData.boxscore.teams.away
    team.battingOrder = team.battingOrder.slice(1)
    team.defense.RF = null
    // Bobby (was RF) and Julio bat with no place; Mookie pitches only.
    expect(codes(state).slice(-2)).deep.equals([12, 11])
  })

  it('leaves the bench out', function () {
    const state = session()
    const team = state.liveData.boxscore.teams.away
    team.battingOrder = team.battingOrder.slice(0, 9)
    const lineup = lineupQrOf(state, 'away')
    const names = [...lineup.h, ...lineup.n].map(player => player.f)
    expect(names).not.includes('Julio')
    expect(names).has.length(9)
  })

  it('packs each id by its kind', function () {
    const state = session()
    const local = addPlayerDraft(
      state,
      'away',
      {
        ...emptyPlayerDraft(),
        firstName: 'Corey',
        lastName: 'Seager',
        jersey: '5'
      },
      900
    )
    const team = state.liveData.boxscore.teams.away
    team.battingOrder = [team.battingOrder[0], local]
    const lineup = lineupQrOf(state, 'away')
    expect(lineup.t).equals(packTeamId('away'))
    expect(lineup.e).equals(packGameId(state.gamePk))
    expect(lineup.h[0].i).equals(packPlayerId(team.battingOrder[0]))
    expect(lineup.h[1].i).equals(packPlayerId(900))
    expect(unpackId(lineup.h[1].i)).deep.equals({
      kind: 'player',
      payload: 900n
    })
  })

  it('splits a full name with no parts at its last space', function () {
    const state = session()
    const team = state.liveData.boxscore.teams.away
    const id = team.battingOrder[0]
    Object.assign(state.gameData.players[id], {
      fullName: 'Elly De La Cruz',
      firstName: undefined,
      lastName: undefined,
      jersey: ' 44 '
    })
    state.gameData.players[team.battingOrder[1]].fullName = 'Ichiro'
    const [first, second] = lineupQrOf(state, 'away').h
    expect(first).deep.include({ f: 'Elly De La', l: 'Cruz', n: '44' })
    expect(second).deep.include({ f: 'Ichiro', l: '' })
  })

  it('shares an empty side as an empty lineup', function () {
    const state = session()
    const team = state.liveData.boxscore.teams.away
    team.battingOrder = []
    for (const position of Object.keys(team.defense) as Position[])
      team.defense[position] = null
    const lineup = lineupQrOf(state, 'away')
    expect(lineup.h).deep.equals([])
    expect(lineup.n).deep.equals([])
  })

  it('reads back into another side as the same order and places', async function () {
    const state = session()
    const team = state.liveData.boxscore.teams.away
    team.battingOrder = team.battingOrder.slice(1)
    const scanned = decodeLineupQr(encodeLineupQr(lineupQrOf(state, 'away')))
    const home = state.liveData.boxscore.teams.home
    home.players = []
    home.battingOrder = []
    for (const position of Object.keys(home.defense) as Position[])
      home.defense[position] = null
    let guest = 1000
    const { draft, benched } = await applyLineupQr(
      state,
      'home',
      scanned,
      [],
      async (_side, player) =>
        asRosterEntry({
          ...ROSTER[0],
          userId: userIdOfGumbo(guest),
          gumboId: guest++,
          shortName: player.firstName
        })
    )
    expect(benched).deep.equals([])
    const name = (id: number): string => draft.gameData.players[id].fullName
    const away = draft.liveData.boxscore.teams.away
    const back = draft.liveData.boxscore.teams.home
    expect(back.battingOrder.map(name)).deep.equals(
      away.battingOrder.map(id => {
        const { firstName, lastName } = draft.gameData.players[id]
        return firstName == null ? name(id) : `${firstName} ${lastName}`
      })
    )
    for (const position of Object.keys(away.defense) as Position[])
      expect(back.defense[position] == null).equals(
        away.defense[position] == null
      )
    expect(back.players).has.length(10)
  })
})
