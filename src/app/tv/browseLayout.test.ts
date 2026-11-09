import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asVideoGame } from '../../common/api'
import {
  browseGeometry,
  collectionGradientLayout,
  fourAcross,
  gameDate,
  heroDetailsScale,
  monthOf,
  monthSections
} from './browseLayout'

describe('TV browsing layout', () => {
  it('uses the viewer timezone for UTC-stored games and month boundaries', () => {
    const original = Object.getOwnPropertyDescriptor(
      Intl.DateTimeFormat.prototype,
      'resolvedOptions'
    )!.value as Intl.DateTimeFormat['resolvedOptions']
    let zone = 'America/Los_Angeles'
    Intl.DateTimeFormat.prototype.resolvedOptions = function (
      this: Intl.DateTimeFormat
    ): Intl.ResolvedDateTimeFormatOptions {
      return { ...original.call(this), timeZone: zone }
    }
    try {
      const game = { startAt: '2025-12-10T20:00:00Z', timezone: 'UTC' }
      expect(gameDate(game)).equals('December 10 at 12 pm')
      expect(gameDate({ ...game, startAt: '2025-07-10T20:00:00Z' })).equals(
        'July 10 at 1 pm'
      )
      const boundary = { ...game, startAt: '2025-10-01T01:00:00Z' }
      expect(gameDate(boundary)).equals('September 30 at 6 pm')
      expect(monthOf(boundary)).equals('September 2025')
      zone = 'Asia/Tokyo'
      expect(gameDate(game)).equals('December 11 at 5 am')
      expect(monthOf(boundary)).equals('October 2025')
    } finally {
      Intl.DateTimeFormat.prototype.resolvedOptions = original
    }
  })
  it('handles unknown dates and invalid viewer zones', () => {
    const game = { startAt: '2025-10-01T01:00:00Z', timezone: 'UTC' }
    expect(gameDate(game, 'unknown')).equals('October 1 at 1 am UTC')
    expect(monthOf(game, 'unknown')).equals('October 2025')
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
    const sections = monthSections(games, 'UTC')
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
          expect(layout.tileWidth).closeTo(((width - 224) / 4) * 0.85, 0.01)
          expect(layout.tileGap).greaterThan(24)
          // Keep four complete cards and a 52-point preview of the fifth.
          const fifthLeft = 76 + 4 * (layout.tileWidth + layout.tileGap)
          expect(fifthLeft).closeTo(width - 52, 0.01)
          expect(76 + 4 * layout.tileWidth + 3 * layout.tileGap).lessThan(width)
        }
      }
    }
  })
  it('fits wrapped matchup names and a venue without overlapping the first row', () => {
    const { heroHeight } = browseGeometry(1280, 605, false)
    for (const fontScale of [1, 1.3]) {
      for (const measuredHeight of [0, 440, 640, 820]) {
        const scale = heroDetailsScale(heroHeight, fontScale, measuredHeight)
        expect(measuredHeight * scale).at.most(heroHeight)
        expect(scale).at.most(1)
      }
    }
    expect(heroDetailsScale(1000, 1, 640)).equals(1)
  })
  it('scrolls the entire fade above the header while its dark tail still covers the screen', () => {
    for (const rowHeight of [250, 400]) {
      const screenHeight = 1080
      const layout = collectionGradientLayout(650, rowHeight, screenHeight)
      const fadeHeight = layout.height / 4
      expect(layout.outputRange[0]).equals(650)
      expect(layout.outputRange[1] + fadeHeight).equals(0)
      expect(layout.outputRange[1] + layout.height).at.least(screenHeight)
      expect(layout.inputRange[1]).equals(
        layout.outputRange[0] - layout.outputRange[1]
      )
    }
  })
})
