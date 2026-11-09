import type { Cleaner } from 'cleaners'

import type { GamesPageQuery, Page, TeamStationClient } from '../../common/api'

/**
 * The schedule reads the phone keeps as one set of games: Upcoming, Past,
 * All and Videos, a team's schedule and videos pages, a season's games and a
 * public games page. Each is recognized here by its path, and stored as one
 * row per game and shape with the page that returned it (`cacheStore.ts`),
 * never under its query string.
 */

/** The game shape a schedule read answers, which its rows are kept as. */
export type ScheduleShape = 'SeasonGame' | 'GameSummary' | 'PublicGame'

/** What one schedule read is. */
export interface ScheduleRead {
  /** `me`, `team:<id>`, `season:<id>` or `group:<id>`. */
  scope: string
  /** From the query: `when`, then `+videos` and `+<order>` when set. */
  window: string
  /** The request's `cursor`; `first` for a paged read without one; `list` unpaged. */
  cursor: string
  shape: ScheduleShape
  /** Answered with a `Page`, not an array. */
  paged: boolean
  /**
   * The query is a `cursor` and nothing that names a window: it takes the
   * window of the stored page whose cursor issued it.
   */
  cursorOnly: boolean
}

/** The cursor of a paged read with none: a list's first page. */
export const FIRST_PAGE = 'first'
/** The cursor of an unpaged read: the whole list. */
export const WHOLE_LIST = 'list'

export const ME_SCOPE = 'me'
export const teamScope = (teamId: string): string => `team:${teamId}`
export const seasonScope = (seasonId: string): string => `season:${seasonId}`
/** A team's or a season's public page. */
export const groupScope = (id: string): string => `group:${id}`

/** The shape of each scope's games. */
export function shapeOfScope(scope: string): ScheduleShape {
  return scope.startsWith('team:')
    ? 'GameSummary'
    : scope.startsWith('group:')
      ? 'PublicGame'
      : 'SeasonGame'
}

/** The window name of a list, the same for every scope. */
export function windowName(options: {
  when?: string
  videos?: boolean
  order?: string
}): string {
  return [
    options.when ?? 'all',
    ...(options.videos === true ? ['videos'] : []),
    ...(options.order == null ? [] : [options.order])
  ].join('+')
}

/** The window a screen's query reads, as `scheduleReadOf` names it. */
export function scheduleWindow(query: GamesPageQuery): string {
  return windowName({
    when: query.when,
    videos: query.hasVideo,
    order: query.order
  })
}

/**
 * What the device stored for a screen's list, to paint before the list's
 * own read returns, or none: nothing stored (the web stores nothing), or a
 * client that keeps no schedule.
 */
export async function storedSchedule<T>(
  client: TeamStationClient,
  scope: string,
  query: GamesPageQuery,
  cleaner: Cleaner<T>
): Promise<Page<T> | undefined> {
  try {
    const page = await client.scheduleGames(
      scope,
      scheduleWindow(query),
      cleaner
    )
    return page.items.length > 0 || page.counts != null ? page : undefined
  } catch {
    return undefined
  }
}

/** What a paged read's query may hold; anything else is not a schedule read. */
const PAGE_PARAMS = new Set([
  'paged',
  'when',
  'order',
  'hasVideo',
  'around',
  'cursor',
  'limit'
])
const WHENS = new Set(['upcoming', 'past', 'all'])
const ORDERS = new Set(['asc', 'desc'])

function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/**
 * The schedule read `path` is, or none. `/events` with `played`,
 * `externalId` or any other filter is not one (Home's recent game, a
 * GameChanger lookup): those stay documents.
 */
export function scheduleReadOf(path: string): ScheduleRead | undefined {
  const at = path.indexOf('?')
  const pathname = at < 0 ? path : path.slice(0, at)
  const params = new URLSearchParams(at < 0 ? '' : path.slice(at + 1))
  const allowed = new Set(PAGE_PARAMS)
  let scope: string | undefined
  if (pathname === '/events') {
    allowed.add('season')
    const seasons = params.getAll('season')
    if (seasons.length > 1) return undefined
    scope =
      seasons.length === 0
        ? ME_SCOPE
        : seasons[0] === ''
          ? undefined
          : seasonScope(seasons[0])
  } else {
    const match = /^\/(teams|seasons)\/([^/?]+)\/games$/.exec(pathname)
    const id = match == null ? undefined : decoded(match[2])
    if (match == null || id == null) return undefined
    // A public page first: `/teams/:id/games?public=1` is not the team's own.
    if (params.get('public') === '1') {
      allowed.add('public')
      scope = groupScope(id)
    } else if (match[1] === 'teams') scope = teamScope(id)
  }
  if (scope == null) return undefined
  for (const key of params.keys()) if (!allowed.has(key)) return undefined

  const when = params.get('when') ?? undefined
  if (when != null && !WHENS.has(when)) return undefined
  const order = params.get('order') ?? undefined
  if (order != null && !ORDERS.has(order)) return undefined
  const hasVideo = params.get('hasVideo')
  if (hasVideo != null && hasVideo !== '1') return undefined
  const paged = params.get('paged') === '1'
  const cursor = params.get('cursor')
  return {
    scope,
    window: windowName({ when, videos: hasVideo === '1', order }),
    cursor: cursor ?? (paged ? FIRST_PAGE : WHOLE_LIST),
    shape: shapeOfScope(scope),
    paged,
    cursorOnly:
      cursor != null && when == null && order == null && hasVideo == null
  }
}
