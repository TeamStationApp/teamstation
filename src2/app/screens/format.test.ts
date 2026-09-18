import { expect } from 'chai'
import { describe, it } from 'mocha'

import { matchupLines } from './format'

const game = {
  homeTeamId: 'tem_home',
  awayTeamId: 'tem_away',
  homeTeamName: 'Black Sox',
  awayTeamName: 'AAA Hawks'
}

describe('how a fixture is written', function () {
  it('states the fixture when there is no side to take', function () {
    expect(matchupLines(game)).deep.equals({
      first: 'AAA Hawks',
      second: '@ Black Sox'
    })
  })

  it('says `@` when the team travelled', function () {
    expect(matchupLines(game, 'tem_away')).deep.equals({
      first: 'AAA Hawks',
      second: '@ Black Sox'
    })
  })

  it('says `vs` when the team was at home', function () {
    expect(matchupLines(game, 'tem_home')).deep.equals({
      first: 'Black Sox',
      second: 'vs AAA Hawks'
    })
  })

  it('falls back to the fixture for a team that is not playing', function () {
    expect(matchupLines(game, 'tem_someone_else').second).equals('@ Black Sox')
  })
})
