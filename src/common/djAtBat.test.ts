import { expect } from 'chai'
import { describe, it } from 'mocha'

import { atBatFromCurrentPlay } from './djAtBat'

describe('atBatFromCurrentPlay', function () {
  it('reads the side and the batter from the plate appearance in progress', function () {
    expect(
      atBatFromCurrentPlay({
        about: {
          atBatIndex: 4,
          inning: 2,
          halfInning: 'bottom',
          isComplete: false
        },
        matchup: { batter: { id: 42 } }
      })
    ).deep.equals({ side: 'home', userId: 42 })
    expect(
      atBatFromCurrentPlay({
        about: {
          atBatIndex: 0,
          inning: 1,
          halfInning: 'top',
          isComplete: false
        },
        matchup: { batter: { id: null, fullName: 'Guest' } }
      })
    ).deep.equals({ side: 'away', userId: null })
  })

  it('is none when nothing is in progress, or the document is not a play', function () {
    expect(atBatFromCurrentPlay(null)).equals(null)
    expect(atBatFromCurrentPlay(undefined)).equals(null)
    expect(
      atBatFromCurrentPlay({
        about: { atBatIndex: 0, inning: 1, halfInning: 'top', isComplete: true }
      })
    ).equals(null)
    expect(atBatFromCurrentPlay({ about: { halfInning: 'top' } })).equals(null)
  })
})
