import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  coachSurname,
  isUndeterminedName,
  normaliseTeamName
} from './teamNames'

describe('team names', function () {
  it('normalises the spellings of one team to one name', function () {
    expect(normaliseTeamName('Mid City 1')).equals('mid city')
    expect(normaliseTeamName('Black Sox (Boren)')).equals('black sox')
    expect(normaliseTeamName('Pueyers - Livestream')).equals('pueyers')
    expect(normaliseTeamName('Pueyers (partial)')).equals('pueyers')
    expect(normaliseTeamName("  St. Mary's  Hawks!")).equals('st mary s hawks')
    expect(normaliseTeamName('Diablos')).equals(normaliseTeamName('diablos 2'))
  })

  it("reads a coach's surname from a bracket or the last word", function () {
    expect(coachSurname('Black Sox (Boren)')).equals('boren')
    expect(coachSurname('NP3 Boren')).equals('boren')
    expect(coachSurname('Mid City 1')).equals(undefined)
    expect(coachSurname('Hawks AA')).equals(undefined)
    expect(coachSurname("Team O'Neil")).equals("o'neil")
  })

  it('knows a name that names no opponent yet', function () {
    for (const name of [
      'TBD',
      ' tba ',
      'TBD- 01/02/26, 9:30 AM',
      'tbd Oct 04',
      'To be determined',
      'to be decided',
      'To Be Announced (Pool B)'
    ])
      expect(isUndeterminedName(name), name).equals(true)
    for (const name of ['TBDs', 'Tbilisi', 'Rattlers', 'Team TBD', 'To be'])
      expect(isUndeterminedName(name), name).equals(false)
  })
})
