import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { SponsoredRow } from '../../common/sponsors/types'
import { rowWindow } from '../screens/whenFilter'
import {
  isSponsored,
  keyWithSponsored,
  type WithSponsored,
  withSponsoredRows
} from './sponsoredRows'

const NOW = Date.parse('2027-04-10T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const at = (days: number): string => new Date(NOW + days * DAY).toISOString()

interface Game {
  id: string
  startAt: string | null
}
const game = (id: string, days: number | null): Game => ({
  id,
  startAt: days == null ? null : at(days)
})
const row = (id: string, days: number): SponsoredRow => ({
  id,
  leagueId: 'lea_a',
  logoUrl: 'https://media.example.test/l.png',
  backgroundUrl: 'https://media.example.test/b.png',
  title: id,
  message: 'Fresh bread',
  url: 'https://example.test/bread',
  textColor: 'dark',
  startsAt: at(days)
})
const startOf = (each: Game): string | null => each.startAt
const COMPLETE = { start: true, end: true }
const ALL = rowWindow('all', NOW)
/** Each item's name: a game's id, or `+` and the row's id. */
const names = (items: Array<WithSponsored<Game>>): string[] =>
  items.map(item => (isSponsored(item) ? `+${item.row.id}` : item.id))

/** U32: where a Schedule's sponsored rows sit among its loaded games. */
describe('U32 withSponsoredRows', function () {
  describe('ascending', function () {
    const games = [game('g1', 1), game('g2', 3), game('g3', 5)]

    it('puts a row between the two games it falls between', function () {
      expect(
        names(
          withSponsoredRows(games, [row('r', 2)], startOf, 'asc', COMPLETE, ALL)
        )
      ).deep.equals(['g1', '+r', 'g2', 'g3'])
    })

    it('puts a row after the last loaded game only when the end is complete', function () {
      const late = [row('r', 9)]
      expect(
        names(
          withSponsoredRows(
            games,
            late,
            startOf,
            'asc',
            { start: true, end: false },
            ALL
          )
        )
      ).deep.equals(['g1', 'g2', 'g3'])
      expect(
        names(withSponsoredRows(games, late, startOf, 'asc', COMPLETE, ALL))
      ).deep.equals(['g1', 'g2', 'g3', '+r'])
    })

    it('puts a row before the first loaded game only when the start is complete', function () {
      const early = [row('r', 0)]
      expect(
        names(
          withSponsoredRows(
            games,
            early,
            startOf,
            'asc',
            { start: false, end: true },
            ALL
          )
        )
      ).deep.equals(['g1', 'g2', 'g3'])
      expect(
        names(withSponsoredRows(games, early, startOf, 'asc', COMPLETE, ALL))
      ).deep.equals(['+r', 'g1', 'g2', 'g3'])
    })

    it('orders several rows by their start, and puts a row before a game with no start', function () {
      const undated = [...games, game('g4', null)]
      expect(
        names(
          withSponsoredRows(
            undated,
            [row('r9', 9), row('r2b', 2), row('r2a', 2)],
            startOf,
            'asc',
            COMPLETE,
            ALL
          )
        )
      ).deep.equals(['g1', '+r2a', '+r2b', 'g2', 'g3', '+r9', 'g4'])
    })
  })

  describe('window', function () {
    const rows = [row('past', -2), row('ahead', 2)]

    it('keeps an upcoming list, whose start is complete, to rows still ahead', function () {
      const upcoming = [game('g1', 1), game('g2', 3)]
      expect(
        names(
          withSponsoredRows(
            upcoming,
            rows,
            startOf,
            'asc',
            { start: true, end: false },
            rowWindow('upcoming', NOW)
          )
        )
      ).deep.equals(['g1', '+ahead', 'g2'])
    })

    it('keeps a past list to rows not ahead, and all to both', function () {
      const past = [game('g1', -1), game('g2', -3)]
      expect(
        names(
          withSponsoredRows(
            past,
            rows,
            startOf,
            'desc',
            { start: true, end: false },
            rowWindow('past', NOW)
          )
        )
      ).deep.equals(['g1', '+past', 'g2'])
      expect(
        names(
          withSponsoredRows(
            [game('g1', -3), game('g2', 3)],
            rows,
            startOf,
            'asc',
            COMPLETE,
            rowWindow('all', NOW)
          )
        )
      ).deep.equals(['g1', '+past', '+ahead', 'g2'])
    })

    it('counts a row at this very moment as past, as a game is', function () {
      const now = [row('now', 0)]
      expect(now.filter(rowWindow('upcoming', NOW))).deep.equals([])
      expect(now.filter(rowWindow('past', NOW))).deep.equals(now)
    })
  })

  describe('descending', function () {
    const games = [game('g3', 5), game('g2', 3), game('g1', 1)]

    it('puts a row between the two games it falls between', function () {
      expect(
        names(
          withSponsoredRows(
            games,
            [row('r', 4)],
            startOf,
            'desc',
            COMPLETE,
            ALL
          )
        )
      ).deep.equals(['g3', '+r', 'g2', 'g1'])
    })

    it('puts an older row after the last loaded game only when the end is complete, and a newer one first only when the start is', function () {
      const rows = [row('old', 0), row('new', 9)]
      expect(
        names(
          withSponsoredRows(
            games,
            rows,
            startOf,
            'desc',
            { start: false, end: false },
            ALL
          )
        )
      ).deep.equals(['g3', 'g2', 'g1'])
      expect(
        names(withSponsoredRows(games, rows, startOf, 'desc', COMPLETE, ALL))
      ).deep.equals(['+new', 'g3', 'g2', 'g1', '+old'])
    })
  })

  describe('edge cases', function () {
    it('puts a row after a game at the same time, in either order', function () {
      const same = [row('r', 3)]
      expect(
        names(
          withSponsoredRows(
            [game('g1', 1), game('g2', 3), game('g3', 5)],
            same,
            startOf,
            'asc',
            COMPLETE,
            ALL
          )
        )
      ).deep.equals(['g1', 'g2', '+r', 'g3'])
      expect(
        names(
          withSponsoredRows(
            [game('g3', 5), game('g2', 3), game('g1', 1)],
            same,
            startOf,
            'desc',
            COMPLETE,
            ALL
          )
        )
      ).deep.equals(['g3', 'g2', '+r', 'g1'])
    })

    it('leaves the row at its time when a game is added or moved', function () {
      const rows = [row('r', 2)]
      const before = [game('g1', 1), game('g2', 3)]
      expect(
        names(withSponsoredRows(before, rows, startOf, 'asc', COMPLETE, ALL))
      ).deep.equals(['g1', '+r', 'g2'])
      // g2 moved to before the row, and g0 added after it.
      const after = [game('g1', 1), game('g2', 1.5), game('g0', 4)]
      expect(
        names(withSponsoredRows(after, rows, startOf, 'asc', COMPLETE, ALL))
      ).deep.equals(['g1', 'g2', '+r', 'g0'])
    })

    it('shows an empty list’s rows only when it is complete both ways', function () {
      const rows = [row('r', 2)]
      expect(
        names(withSponsoredRows([], rows, startOf, 'asc', COMPLETE, ALL))
      ).deep.equals(['+r'])
      for (const ends of [
        { start: true, end: false },
        { start: false, end: true }
      ])
        expect(
          names(withSponsoredRows([], rows, startOf, 'asc', ends, ALL))
        ).deep.equals([])
    })

    it('answers a copy of the games when no row is kept', function () {
      const games = [game('g1', 1)]
      const spliced = withSponsoredRows(
        games,
        [],
        startOf,
        'asc',
        COMPLETE,
        ALL
      )
      expect(spliced).deep.equals(games)
      expect(spliced).not.equals(games)
    })

    it('keys a row apart from every game, and tells the two apart', function () {
      const key = keyWithSponsored((each: Game) => each.id)
      const [placed] = withSponsoredRows(
        [],
        [row('srw_a', 1)],
        startOf,
        'asc',
        COMPLETE,
        ALL
      )
      expect(key(placed)).equals('sponsored:srw_a')
      expect(key(game('srw_a', 1))).equals('srw_a')
      expect(isSponsored({ kind: 'sponsored' } as unknown as Game)).equals(
        false
      )
      expect(isSponsored(null as unknown as Game)).equals(false)
    })
  })
})
