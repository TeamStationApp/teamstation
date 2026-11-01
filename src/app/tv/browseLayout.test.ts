import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asVideoGame } from '../../common/api'
import {
  browseGeometry,
  collectionTop,
  fourAcross,
  gameDate,
  monthOf,
  monthSections
} from './browseLayout'

describe('TV browsing layout', () => {
  it('uses the event timezone and handles unknown dates and invalid zones', () => {
    const game = {
      startAt: '2026-10-01T01:00:00Z',
      timezone: 'America/Los_Angeles'
    }
    expect(monthOf(game)).equals('September 2026')
    expect(gameDate(game)).equals('September 30 at 6 pm')
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
  it('reserves a complete first row and four thumbnails with room for native lift', () => {
    for (const width of [1280, 1920, 3840]) {
      for (const monthly of [false, true]) {
        for (const fontScale of [1, 1.3]) {
          const height = (width * 9) / 16 - 115
          const layout = browseGeometry(width, height, monthly, fontScale)
          expect(layout.heroHeight + layout.rowHeight).closeTo(height, 0.01)
          expect(152 + 4 * layout.tileWidth + 3 * 24).equals(width)
          // The viewport includes lift gutters, but the fifth starts outside it.
          const fifthLeft = 76 + 4 * (layout.tileWidth + 24)
          expect(fifthLeft).equals(width - 52)
          expect(layout.tileWidth).greaterThan((width - 224) / 4 - 12)
        }
      }
    }
  })
  it('moves the collection transition with scrolling and pins it at the viewport top', () => {
    expect(collectionTop(500, 0)).equals(500)
    expect(collectionTop(500, 250)).equals(250)
    expect(collectionTop(500, 700)).equals(0)
    expect(collectionTop(500, -30)).equals(500)
    expect(browseGeometry(1280, 605, false).heroHeight).at.least(0)
  })
})
