import { expect } from 'chai'
import { describe, it } from 'mocha'

import { inningsOf, modalInnings } from './regulation'

describe('how long a game here runs', function () {
  it('takes the length most of the games ran', function () {
    // Four short games and a dozen full ones: the league plays six.
    expect(modalInnings([6, 6, 6, 5, 4, 6, 1, 6])).equals(6)
  })

  it('has no answer where there are no games', function () {
    expect(modalInnings([])).equals(null)
    expect(modalInnings([0, -1])).equals(null)
  })

  it('takes the longer where two lengths tie', function () {
    // A regulation game can be cut short and cannot be cut long, so the
    // longer of two equally common lengths is the one that was meant.
    expect(modalInnings([5, 5, 6, 6])).equals(6)
  })

  it('reads a game’s length off its line score', function () {
    expect(
      inningsOf({ home: { runs: [0, 1, 0] }, away: { runs: [2, 0, 0] } })
    ).equals(3)
  })

  it('ignores an inning the visitors were credited with and never played', function () {
    // Four of the five games in one season read like this, and counting the
    // padded seventh made a six-inning league look like a seven-inning one.
    expect(
      inningsOf({
        home: { runs: [0, 2, 0, 2, 0, 2] },
        away: { runs: [4, 0, 0, 0, 0, 3, 0] }
      })
    ).equals(6)
  })

  it('has no answer for a game with no line score', function () {
    expect(inningsOf(null)).equals(null)
    expect(inningsOf({ home: { runs: [] }, away: { runs: [] } })).equals(null)
  })
})
