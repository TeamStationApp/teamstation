import type { Route, When } from './routes'

/**
 * The Videos tab and the Schedule tab each remember their own filter.
 *
 * One shared value is how opening Videos (which is Past) made the next visit
 * to Schedule open on Past as well. A videos address writes only the videos
 * filter, and a schedule address writes only the schedule filter.
 */
export interface TabFilters {
  videos: When
  schedule: When
}

/** The pair a cold open starts from. The tab that is not in the address keeps its own default. */
export function initialTabFilters(route: Route): TabFilters {
  return {
    videos: route.name === 'videos' ? route.when : 'past',
    schedule: route.name === 'schedule' ? route.when : 'upcoming'
  }
}

/** Replaces one tab's filter and leaves the other tab as it was. */
export function withFilter(
  filters: TabFilters,
  tab: 'videos' | 'schedule',
  when: When
): TabFilters {
  return { ...filters, [tab]: when }
}

/**
 * The filters a navigation lands on.
 *
 * A videos or schedule address writes that tab and leaves the other. Any
 * other address leaves both, so Back from a game does not reset the list
 * the game was opened from.
 */
export function filtersForRoute(filters: TabFilters, route: Route): TabFilters {
  if (route.name === 'videos') {
    return filters.videos === route.when
      ? filters
      : withFilter(filters, 'videos', route.when)
  }
  if (route.name === 'schedule') {
    return filters.schedule === route.when
      ? filters
      : withFilter(filters, 'schedule', route.when)
  }
  return filters
}
