import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asSideTeamId,
  namedTeamIds,
  OPEN_SIDE_NAME,
  openSidesOf,
  sideName,
  wireSideId
} from './openSides'
import { teamsOfRow } from './teamLists'

describe('open sides', () => {
  it('names an open side TBD', () => {
    expect(OPEN_SIDE_NAME).equals('TBD')
  })

  it('answers an open side with the id "" and a named side unchanged', () => {
    expect(wireSideId(null)).equals('')
    expect(wireSideId('team-1')).equals('team-1')
  })

  it('reads "" as an open side, keeps a named id and refuses a non-string', () => {
    expect(asSideTeamId('')).equals(null)
    expect(asSideTeamId('team-1')).equals('team-1')
    expect(() => asSideTeamId(null)).throws(TypeError)
    expect(() => asSideTeamId(7)).throws(TypeError)
  })

  it('lists only the named teams', () => {
    expect(namedTeamIds('a', null, 'b')).deep.equals(['a', 'b'])
    expect(namedTeamIds(null, null)).deep.equals([])
    expect(namedTeamIds()).deep.equals([])
  })

  it('finds no, one or both open sides', () => {
    expect(openSidesOf({ homeTeamId: 'a', awayTeamId: 'b' })).deep.equals([])
    expect(openSidesOf({ homeTeamId: 'a', awayTeamId: null })).deep.equals([
      'away'
    ])
    expect(openSidesOf({ homeTeamId: null, awayTeamId: 'b' })).deep.equals([
      'home'
    ])
    expect(openSidesOf({ homeTeamId: null, awayTeamId: null })).deep.equals([
      'home',
      'away'
    ])
  })

  it("gives a game row's open side the id ''", () => {
    expect(teamsOfRow({ home_team_id: 'a', away_team_id: null })).deep.equals({
      away: { id: '' },
      home: { id: 'a' }
    })
  })

  it('names a side by its team, TBD when open, else the fallback', () => {
    const names = { 'team-ravens': 'Ravens' }
    expect(sideName(names, null, 'Away team')).equals(OPEN_SIDE_NAME)
    expect(sideName(names, 'team-ravens', 'Away team')).equals('Ravens')
    expect(sideName(names, 'team-gone', 'Home team')).equals('Home team')
  })
})
