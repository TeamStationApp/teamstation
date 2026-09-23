import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGameDetail } from '../../common/api'
import { isUnscoredGame } from './isUnscoredGame'

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
