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
    expect(normaliseTeamName('Bay Stars (Mize)')).equals('bay stars')
    expect(normaliseTeamName('Otters - Livestream')).equals('otters')
    expect(normaliseTeamName('Otters (partial)')).equals('otters')
    expect(normaliseTeamName("  St. Mary's  Hawks!")).equals('st mary s hawks')
    expect(normaliseTeamName('Dragons')).equals(normaliseTeamName('dragons 2'))
  })

  it("reads a coach's surname from a bracket or the last word", function () {
    expect(coachSurname('Bay Stars (Mize)')).equals('mize')
    expect(coachSurname('NP3 Mize')).equals('mize')
    expect(coachSurname('Mid City 1')).equals(undefined)
    expect(coachSurname('Hawks AA')).equals(undefined)
    expect(coachSurname("Team O'Neill")).equals("o'neill")
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
