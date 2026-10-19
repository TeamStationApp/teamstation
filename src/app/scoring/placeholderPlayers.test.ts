import { expect } from 'chai'
import { describe, it } from 'mocha'

import { guestCreator } from '../../test/guestPlayers'
import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  addPlaceholderPlayers,
  PartialPlaceholderCreation,
  placeholderSuffix,
  placeholderTeamName
} from './placeholderPlayers'
import { initialScoringState, scoringReducer } from './scoringMachine'

// Sample names for the abbreviation rules.
const productionNames: Array<[string, string]> = [
  ['11u Blue Vale Titans', '11 Bl Vl'],
  ['619 Pilots 11U', '6P1'],
  ['Alta Hawks', 'Alta Hawks'],
  ['Amber Gardens', 'AGrdns'],
  ['Badgers (Ripken)', 'BRpkn'],
  ['Bay Stars (Mize)', 'BSM'],
  ['Bay Widows (Votto)', 'BWV'],
  ['Canyon Creek', 'Cnyn Crk'],
  ['Dragons', 'Dragons'],
  ['Ember', 'Ember'],
  ['CLB 2034 11U', 'C21'],
  ['Oak Ridge National', 'ORN'],
  ['Cedar Lakes', 'Cdr Lks'],
  ['MC1 Lofton', 'MC1 Lofton'],
  ['QPLL 8-10 All-Stars 2026', 'QPLL 8 10'],
  ['MVP Rounders 10U', 'MR1'],
  ['Monument Trails', 'MTrls'],
  ['NP1 Harper', 'NP1 Harper'],
  ['NP5 Maddux', 'NP5 Maddux'],
  ['QPLL 10U All Stars 2026', 'Q1A'],
  ['QPLL PAT Team', 'QPT'],
  ['North Pines Ravens - McCann', 'NPR'],
  ['North Pines Seagulls', 'NPS'],
  ['Headland', 'Headland'],
  ['Otters', 'Otters'],
  ['Posey', 'Posey'],
  ['AC Crush 11U Black', 'AC1'],
  ['AC Hustle 10U', 'AH1'],
  ['AC Rattlers 10U', 'AR1'],
  ['SS1 Alvarez', 'SS1 lvrz'],
  ['SS2 Strawberry', 'SStrwbrr'],
  ['Elm Park 3', 'Elm Park 3'],
  ['Bay City Roosters 9U', 'BCR'],
  ['Elm Meadow Impact 11U', 'EMI'],
  ['Cedar Mesa 1', 'Cdr Ms 1'],
  ['Silver Ridge', 'Slvr Rdg'],
  ['QLL 8-10 All Stars 2026', 'QLL 8 10'],
  ['Team Altuve North Flow Black 11U', 'TAN'],
  ['Timberland 2', 'T2'],
  ['Timberlin', 'Timberlin'],
  ['Titan Force 11U', 'TF1'],
  ['Cyclones', 'Cyclones'],
  ['HC Squirrels', 'HSqrrls'],
  ['West Baseball Navy 9U', 'WBN']
]
describe('team-named placeholder players', function () {
  it('preserves the draft and original error when the first creation fails', async () => {
    const draft = scoringSession(gameFixture)
    const before = structuredClone(draft)
    const offline = new Error('Offline')
    let failure: unknown
    try {
      await addPlaceholderPlayers(draft, 'home', 3, async () => {
        throw offline
      })
    } catch (error) {
      failure = error
    }
    expect(failure).equals(offline)
    expect(draft).deep.equals(before)
  })
  it('reports acknowledged additions when a later creation fails', async () => {
    const draft = scoringSession(gameFixture)
    const before = draft.liveData.boxscore.teams.home.players.length
    const create = guestCreator()
    let attempts = 0
    let failure: unknown
    try {
      await addPlaceholderPlayers(draft, 'home', 3, async (side, player) => {
        if (++attempts === 3) throw new Error('Offline')
        return await create(side, player)
      })
    } catch (error) {
      failure = error
    }
    expect(failure).instanceOf(PartialPlaceholderCreation)
    expect(failure).includes({ created: 2, remaining: 1 })
    expect((failure as Error).message).includes('Created 2 players.')
    expect(draft.liveData.boxscore.teams.home.players).length(before + 2)
    await addPlaceholderPlayers(draft, 'home', 1, create)
    expect(draft.liveData.boxscore.teams.home.players).length(before + 3)
  })
  for (const [name, expected] of productionNames)
    it(`abbreviates ${name}`, function () {
      expect(placeholderTeamName(name)).equals(expected)
    })
  it('handles normalization, thresholds, leading articles, and one/two/many words', function () {
    for (const [name, expected] of [
      ['', 'Team'],
      [' ()--- ', 'Team'],
      ['The THE', 'Team'],
      [' The Hawks (Red) ', 'Hawks Red'],
      ['Café Owls', 'Cafe Owls'],
      ['0123456789', '0123456789'],
      ['01234567890', '01234567'],
      ['abcdefghijk', 'bcdfghjk'],
      ['abcdefghjklm', 'bcdfghjk'],
      ['aeiouAEIOUa', 'Team'],
      ['abcdefghj k', 'ak'],
      ['North Pines Very Long Team', 'NPV'],
      ['The Red Sox and more', 'Rd Sx nd']
    ])
      expect(placeholderTeamName(name), name).equals(expected)
    expect(placeholderSuffix(0)).equals('A')
    expect(placeholderSuffix(25)).equals('Z')
    expect(placeholderSuffix(26)).equals('AA')
    expect(placeholderSuffix(701)).equals('ZZ')
    expect(placeholderSuffix(702)).equals('AAA')
  })
  it('adds once per batch to the selected roster with defaults, skips collisions and preserves save/undo', async function () {
    const create = guestCreator()
    const initial = initialScoringState(scoringSession(gameFixture))
    const draft = structuredClone(initial.session)
    draft.gameData.teams.away.name = 'Hawks'
    const awayBefore = draft.liveData.boxscore.teams.away.players.length
    const homeBefore = JSON.stringify(draft.liveData.boxscore.teams.home)
    const ids = [
      ...(await addPlaceholderPlayers(draft, 'away', 16, create)),
      ...(await addPlaceholderPlayers(draft, 'away', 16, create))
    ]
    expect(ids).length(32)
    expect(new Set(ids).size).equals(32)
    expect(draft.gameData.players[ids[0]].fullName).equals('Hawks A')
    expect(draft.gameData.players[ids[26]].fullName).equals('Hawks AA')
    const player = draft.gameData.players[ids[0]]
    expect(player).includes({
      bats: 'right',
      throws: 'right',
      jersey: '',
      local: true
    })
    expect(player.positions).deep.equals([])
    expect(draft.liveData.boxscore.teams.away.players).length(awayBefore + 32)
    expect(JSON.stringify(draft.liveData.boxscore.teams.home)).equals(
      homeBefore
    )
    expect(draft.liveData.boxscore.teams.away.battingOrder).deep.equals(
      initial.session.liveData.boxscore.teams.away.battingOrder
    )
    expect(draft.liveData.boxscore.teams.away.defense).deep.equals(
      initial.session.liveData.boxscore.teams.away.defense
    )
    draft.gameData.players[ids[0]].fullName = 'hawks a'
    const next = (await addPlaceholderPlayers(draft, 'away', 1, create))[0]
    expect(draft.gameData.players[next].fullName).equals('Hawks AG')
    await addPlaceholderPlayers(draft, 'home', 1, create)
    const saved = scoringReducer(initial, { type: 'ROSTER', draft })
    expect(saved.session.gameData.players[next].fullName).equals('Hawks AG')
    expect(scoringReducer(saved, { type: 'UNDO' }).session).deep.equals(
      initial.session
    )
    for (const count of [0, 17, -1, 1.5, NaN, Infinity]) {
      let failure: unknown
      try {
        await addPlaceholderPlayers(draft, 'home', count, create)
      } catch (error) {
        failure = error
      }
      expect(String(failure)).contains('between 1 and 16')
    }
  })
})
