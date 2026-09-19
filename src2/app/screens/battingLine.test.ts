import { expect } from 'chai'

import { battingLine } from './format'

describe('how a player bats and throws', function () {
  it('writes both the way a scorecard does', function () {
    expect(battingLine({ bats: 'right', throws: 'right' })).equals(
      'B: R · T: R'
    )
    expect(battingLine({ bats: 'left', throws: 'right' })).equals('B: L · T: R')
  })

  it('writes a switch hitter as both sides', function () {
    expect(battingLine({ bats: 'switch', throws: 'left' })).equals(
      'B: L/R · T: L'
    )
  })

  it('shows the half it knows', function () {
    expect(battingLine({ bats: 'left', throws: null })).equals('B: L')
    expect(battingLine({ bats: null, throws: 'right' })).equals('T: R')
  })

  // Not `B: —`. A dash claims somebody looked; a blank claims nothing, which
  // is what an empty column actually means.
  it('says nothing at all when nobody has said', function () {
    expect(battingLine({ bats: null, throws: null })).equals(undefined)
    expect(battingLine({})).equals(undefined)
  })
})
