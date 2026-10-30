/**
 * The documents the phone keeps, one per GET it can show without a signal,
 * and the key each is stored under.
 *
 * Only these exact requests are stored. `GET /events?season=`, any other
 * query, and every other path are network reads and stay that way, so a
 * season's games are never answered offline with the whole list.
 */
export const HOME_TEAMS = 'home.teams'
export const HOME_SEASONS = 'home.seasons'
export const HOME_GROUPS = 'home.groups'
export const HOME_FOLLOWS = 'home.follows'
export const HOME_GUARDED = 'home.guarded'
export const HOME_RECENT = 'home.recent'
export const ME_ROLES = 'me.roles'
export const GAMES_UPCOMING = 'games.upcoming'
export const GAMES_PAST = 'games.past'
export const GAMES_ALL = 'games.all'
export const GAMES_UPCOMING_PAGE = 'games.upcoming.page'
export const GAMES_PAST_PAGE = 'games.past.page'
export const GAMES_ALL_PAGE = 'games.all.page'
export const GAMES_VIDEOS_PAGE = 'games.videos.page'

export const rosterKey = (teamId: string): string => `roster.${teamId}`
export const fullRosterKey = (teamId: string): string => `roster.full.${teamId}`
export const lineupsKey = (gameId: string): string => `lineups.${gameId}`
export const gameKey = (gameId: string): string => `game.${gameId}`
export const eventsKey = (gameId: string): string => `events.${gameId}`
export const defaultLineupKey = (teamId: string): string =>
  `defaultLineup.${teamId}`

/** The key the first page of one of the feed's lists is stored under. */
export function gamesKey(list: 'past' | 'upcoming' | 'all' | 'videos'): string {
  return list === 'past'
    ? GAMES_PAST_PAGE
    : list === 'upcoming'
      ? GAMES_UPCOMING_PAGE
      : list === 'videos'
        ? GAMES_VIDEOS_PAGE
        : GAMES_ALL_PAGE
}

/** Requests with no id in them, by path and query exactly as sent. */
const FIXED: Record<string, string> = {
  '/teams': HOME_TEAMS,
  '/seasons': HOME_SEASONS,
  '/me/groups': HOME_GROUPS,
  '/me/follows': HOME_FOLLOWS,
  '/users?guardedBy=me': HOME_GUARDED,
  '/events?played=1&limit=1': HOME_RECENT,
  '/me/roles': ME_ROLES,
  '/events?when=upcoming': GAMES_UPCOMING,
  '/events?when=past': GAMES_PAST,
  '/events': GAMES_ALL,
  // A list's first page: a page with a cursor has no document, so it is a
  // network read, and offline a list ends at what is stored.
  '/events?paged=1&when=upcoming': GAMES_UPCOMING_PAGE,
  '/events?paged=1&when=past': GAMES_PAST_PAGE,
  '/events?paged=1': GAMES_ALL_PAGE,
  '/events?paged=1&hasVideo=1': GAMES_VIDEOS_PAGE
}

/** Requests naming one team or game: the pattern, and the key of its id. */
const BY_ID: Array<[RegExp, (id: string) => string]> = [
  [/^\/teams\/([^/?]+)\/roster$/, rosterKey],
  [/^\/teams\/([^/?]+)\/roster\?includeFullNames=true$/, fullRosterKey],
  [/^\/teams\/([^/?]+)\/default-lineup$/, defaultLineupKey],
  [/^\/games\/([^/?]+)$/, gameKey],
  [/^\/games\/([^/?]+)\/lineups$/, lineupsKey],
  [/^\/games\/([^/?]+)\/events$/, eventsKey]
]

/** The document a GET of `path` fills, or none for a request not stored. */
export function documentKeyOf(path: string): string | undefined {
  const fixed = FIXED[path]
  if (fixed != null) return fixed
  for (const [pattern, keyOf] of BY_ID) {
    const match = pattern.exec(path)
    if (match == null) continue
    try {
      return keyOf(decodeURIComponent(match[1]))
    } catch {
      // An id that is not valid percent-encoding names no document.
      return undefined
    }
  }
  return undefined
}

/**
 * The document that stands in for `key` when it is missing offline: a team's
 * plain roster for its full-name one. The full names are only ever stored
 * for a team the person manages.
 */
export function fallbackKeyOf(key: string): string | undefined {
  const prefix = 'roster.full.'
  return key.startsWith(prefix)
    ? rosterKey(key.slice(prefix.length))
    : undefined
}
