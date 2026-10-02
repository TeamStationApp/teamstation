import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGameDetail } from '../../common/api'
import { isUnscoredGame, scoringEntry } from './isUnscoredGame'

export const gameFixture = asGameDetail({
  id: 'g1',
  awayTeamId: 'away',
  homeTeamId: 'home',
  awayTeamName: 'Owls',
  homeTeamName: 'Hawks',
  seasonId: null,
  startAt: null,
  venue: null,
  status: 'scheduled',
  homeScore: null,
  awayScore: null,
  ingestStatus: 'pending',
  ingestMessage: null,
  // Seen by a scorekeeper, so the Score Game tab is on offer.
  canScore: true,
  videos: []
})
describe('unscored entry', function () {
  it('requires all three score fields to be absent', function () {
    expect(isUnscoredGame(gameFixture)).equals(true)
    for (const patch of [
      { homeScore: 0 },
      { awayScore: 0 },
      { homeScore: 1 },
      { homeScore: 0, awayScore: 0 },
      {
        linescore: {
          away: {
            runs: [],
            r: 0,
            h: null,
            e: null,
            bb: null,
            k: null,
            hr: null,
            hbp: null
          },
          home: {
            runs: [],
            r: 0,
            h: null,
            e: null,
            bb: null,
            k: null,
            hr: null,
            hbp: null
          }
        }
      }
    ]) {
      expect(isUnscoredGame({ ...gameFixture, ...patch })).equals(false)
    }
  })
})

describe('the scoring entry on the Game page', function () {
  it('scores an unscored game, continues one TeamStation scores, and offers nothing else', function () {
    expect(scoringEntry(gameFixture)).equals('score')
    expect(
      scoringEntry({
        ...gameFixture,
        scoringOwner: 'gamestation',
        status: 'inProgress',
        awayScore: 1
      })
    ).equals('continue')
    expect(
      scoringEntry({
        ...gameFixture,
        scoringOwner: 'gamestation',
        status: 'final',
        awayScore: 3,
        homeScore: 1
      })
    ).equals('continue')
    expect(
      scoringEntry({
        ...gameFixture,
        scoringOwner: 'external',
        status: 'final',
        awayScore: 3,
        homeScore: 1
      })
    ).equals(null)
    expect(scoringEntry({ ...gameFixture, status: 'final' })).equals(null)
    expect(scoringEntry({ ...gameFixture, status: 'cancelled' })).equals(null)
    expect(
      scoringEntry({
        ...gameFixture,
        scoringOwner: 'gamestation',
        status: 'cancelled'
      })
    ).equals(null)
    expect(scoringEntry({ ...gameFixture, awayScore: 2 })).equals(null)
  })
})
