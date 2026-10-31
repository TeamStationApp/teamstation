import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asVideoGame } from '../../common/api'
import { fourAcross, gameDate, monthOf, monthSections } from './browseLayout'

describe('TV browsing layout', () => {
  it('uses the event timezone and handles unknown dates and invalid zones', () => {
    const game = {
      startAt: '2026-10-01T01:00:00Z',
      timezone: 'America/Los_Angeles'
    }
    expect(monthOf(game)).equals('September 2026')
    expect(gameDate(game)).contains('Sep 30, 2026')
    expect(gameDate({ ...game, timezone: 'unknown' })).contains('UTC')
    expect(monthOf({ ...game, timezone: 'unknown' })).equals('October 2026')
    for (const startAt of [null, 'invalid']) {
      expect(gameDate({ ...game, startAt })).equals('Date to be announced')
      expect(monthOf({ ...game, startAt })).equals('Date to be announced')
    }
  })
  it('keeps chronological monthly sections and four columns without horizontal overflow', () => {
    const games = Array.from({ length: 9 }, (_, i) =>
      asVideoGame({
        id: String(i),
        homeTeamId: 'home',
        awayTeamId: 'away',
        homeTeamName: 'Hosts',
        awayTeamName: 'Visitors',
        homeTeamExternal: false,
        awayTeamExternal: false,
        seasonId: null,
        startAt: i < 5 ? '2026-10-01T15:00:00Z' : '2026-09-01T15:00:00Z',
        timezone: 'UTC',
        venue: null,
        status: 'final',
        homeScore: null,
        awayScore: null,
        ingestStatus: 'ok',
        videoCount: 1,
        latestVideoId: 'video',
        latestVideoAt: '2026-10-01T00:00:00Z'
      })
    )
    const sections = monthSections(games)
    expect(sections.map(s => s.month)).deep.equals([
      'October 2026',
      'September 2026'
    ])
    expect(sections[0].rows.map(row => row.length)).deep.equals([4, 1])
    expect(sections[1].rows[0]).length(4)
    expect(fourAcross([])).deep.equals([])
  })
})
