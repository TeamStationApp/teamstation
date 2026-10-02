import { expect } from 'chai'
import { describe, it } from 'mocha'

import { coachSurname, normaliseTeamName } from './teamNames'

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
})
