import { expect } from 'chai'
import { describe, it } from 'mocha'

import { filtersForRoute, initialTabFilters, withFilter } from './tabFilters'

describe('tab filters', function () {
  it('reads a videos address without touching the schedule', function () {
    expect(initialTabFilters({ name: 'videos', when: 'all' })).deep.equals({
      videos: 'all',
      schedule: 'upcoming'
    })
    expect(initialTabFilters({ name: 'home' })).deep.equals({
      videos: 'past',
      schedule: 'upcoming'
    })
  })

  it('reads a schedule address without touching the videos list', function () {
    expect(initialTabFilters({ name: 'schedule', when: 'past' })).deep.equals({
      videos: 'past',
      schedule: 'past'
    })
  })

  it('changes one tab and leaves the other', function () {
    const filters = { videos: 'past' as const, schedule: 'upcoming' as const }
    expect(withFilter(filters, 'schedule', 'past')).deep.equals({
      videos: 'past',
      schedule: 'past'
    })
    expect(withFilter(filters, 'videos', 'all')).deep.equals({
      videos: 'all',
      schedule: 'upcoming'
    })
    expect(filters).deep.equals({ videos: 'past', schedule: 'upcoming' })
  })

  it('takes a list address onto that tab and leaves the other', function () {
    const filters = { videos: 'past' as const, schedule: 'upcoming' as const }
    expect(
      filtersForRoute(filters, { name: 'schedule', when: 'past' })
    ).deep.equals({ videos: 'past', schedule: 'past' })
    expect(
      filtersForRoute(filters, { name: 'videos', when: 'all' })
    ).deep.equals({ videos: 'all', schedule: 'upcoming' })
    expect(
      filtersForRoute(filters, { name: 'schedule', when: 'upcoming' })
    ).equals(filters)
    expect(filtersForRoute(filters, { name: 'home' })).equals(filters)
    expect(filtersForRoute(filters, { name: 'game', gameId: 'gam_1' })).equals(
      filters
    )
  })
})
