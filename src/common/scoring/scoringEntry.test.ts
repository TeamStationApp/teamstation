import { expect } from 'chai'
import { describe, it } from 'mocha'

import { isUnscoredGame, scoringEntry } from './scoringEntry'

describe('how a game may be scored', () => {
  const unscored = { linescore: null, homeScore: null, awayScore: null }
  it('scores a game nobody has scored', () => {
    expect(scoringEntry({ ...unscored, status: 'scheduled' })).equals('score')
    expect(isUnscoredGame(unscored)).equals(true)
  })
  it('takes up a game TeamStation scores, or one whose plays it replays, even when final', () => {
    expect(scoringEntry({ homeScore: 2, scoringOwner: 'teamstation' })).equals(
      'continue'
    )
    expect(
      scoringEntry({ homeScore: 2, status: 'final', replayable: true })
    ).equals('continue')
  })
  it('offers nothing for a cancelled game, a final one, or one scored elsewhere', () => {
    expect(
      scoringEntry({ status: 'cancelled', scoringOwner: 'teamstation' })
    ).equals(null)
    expect(scoringEntry({ ...unscored, status: 'final' })).equals(null)
    expect(scoringEntry({ homeScore: 3, awayScore: 1 })).equals(null)
    expect(isUnscoredGame({ linescore: { innings: [] } })).equals(false)
  })
})
