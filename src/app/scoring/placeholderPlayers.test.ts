import { expect } from 'chai'
import { describe, it } from 'mocha'

import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import {
  addPlaceholderPlayers,
  placeholderSuffix,
  placeholderTeamName
} from './placeholderPlayers'
import { initialScoringState, scoringReducer } from './scoringMachine'

// Frozen names from production teams.name, read-only snapshot 2026-09-24.
const productionNames: Array<[string, string]> = [
  ['11u Black VBA Taipans', '1BV'],
  ['619 Prospects 11U', '6P1'],
  ['AAA Hawks', 'AAA Hawks'],
  ['Allied Gardens', 'AGrdns'],
  ['Bandits (Ruden)', 'BRdn'],
  ['Black Sox (Boren)', 'BSB'],
  ['Black Widows (Veeh)', 'BWV'],
  ['Chollas Lake', 'Chlls Lk'],
  ['Diablos', 'Diablos'],
  ['Edge', 'Edge'],
  ['FCA 2034 11U', 'F21'],
  ['La Mesa National', 'LMN'],
  ['Lake Murray', 'Lk Mrry'],
  ['MC1 Lopez', 'MC1 Lopez'],
  ['MTLL 8-10 All-Stars 2026', 'MTLL 8 10'],
  ['MVP Rawlings 10U', 'MR1'],
  ['Mission Trails', 'MTrls'],
  ['NP1 Hundley', 'NHndly'],
  ['NP5 Hardy', 'NP5 Hardy'],
  ['NPLL 10U All Stars 2026', 'N1A'],
  ['NPLL PAT Team', 'NPT'],
  ['North Park Rangers - McBride', 'NPR'],
  ['North Park Seagulls', 'NPS'],
  ['Peninsula', 'Peninsula'],
  ['Pueyers', 'Pueyers'],
  ['Rolando', 'Rolando'],
  ['SD Crush 11U Black', 'SC1'],
  ['SD Hustle 10U', 'SH1'],
  ['SD Rattlers 10U', 'SR1'],
  ['SS1 Espinosa', 'SS1 spns'],
  ['SS2 Fitzpatrick', 'SFtzptrc'],
  ['San Carlos 3', 'SC3'],
  ['San Diego Roosters 9U', 'SDR'],
  ['San Marcos Impact 11U', 'SMI'],
  ['Serra Mesa 1', 'Srr Ms 1'],
  ['Sierra Mesa', 'Srr Ms'],
  ['TLL 8-10 All Stars 2026', 'TLL 8 10'],
  ['Team Arrieta LosDel Flow Black 11U', 'TAL'],
  ['Tierrasanta 2', 'Trrsnt 2'],
  ['Tiersanta', 'Tiersanta'],
  ['Trosky Force 11U', 'TF1'],
  ['Tsunamis', 'Tsunamis'],
  ['VC Squirrels', 'VSqrrls'],
  ['Winn Baseball Navy 9U', 'WBN']
]
describe('team-named placeholder players', function () {
  for (const [name, expected] of productionNames)
    it(`abbreviates production team ${name}`, function () {
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
      ['North Park Very Long Team', 'NPV'],
      ['The Red Sox and more', 'Rd Sx nd']
    ])
      expect(placeholderTeamName(name), name).equals(expected)
    expect(placeholderSuffix(0)).equals('A')
    expect(placeholderSuffix(25)).equals('Z')
    expect(placeholderSuffix(26)).equals('AA')
    expect(placeholderSuffix(701)).equals('ZZ')
    expect(placeholderSuffix(702)).equals('AAA')
  })
  it('adds once per batch to the selected roster with defaults, skips collisions and preserves save/undo', function () {
    const initial = initialScoringState(
      createDevelopmentSession(gameFixture, [], [])
    )
    const draft = structuredClone(initial.session)
    draft.gameData.teams.away.name = 'Hawks'
    const awayBefore = draft.liveData.boxscore.teams.away.players.length
    const homeBefore = JSON.stringify(draft.liveData.boxscore.teams.home)
    const ids = [
      ...addPlaceholderPlayers(draft, 'away', 16),
      ...addPlaceholderPlayers(draft, 'away', 16)
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
    const next = addPlaceholderPlayers(draft, 'away', 1)[0]
    expect(draft.gameData.players[next].fullName).equals('Hawks AG')
    addPlaceholderPlayers(draft, 'home', 1)
    const saved = scoringReducer(initial, { type: 'ROSTER', draft })
    expect(saved.session.gameData.players[next].fullName).equals('Hawks AG')
    expect(scoringReducer(saved, { type: 'UNDO' }).session).deep.equals(
      initial.session
    )
    for (const count of [0, 17, -1, 1.5, NaN, Infinity])
      expect(() => addPlaceholderPlayers(draft, 'home', count)).throws(
        'between 1 and 16'
      )
  })
})
