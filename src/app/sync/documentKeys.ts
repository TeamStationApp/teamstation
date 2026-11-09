/**
 * The documents the phone keeps, one per GET it can show without a signal,
 * and the key each is stored under.
 *
 * The reads below keep the short keys they always had, which the outbox and
 * the screens read by name. Every other GET is kept under its path and
 * query, except the denylist (`networkOnly`), which stays a network read. A
 * schedule read (`scheduleReads.ts`) is not a document at all: its games are
 * kept as one set, and `CachingClient` routes it there first.
 */
export const HOME_LISTS = 'home.lists'
export const HOME_TEAMS = 'home.teams'
export const HOME_SEASONS = 'home.seasons'
export const HOME_GROUPS = 'home.groups'
export const HOME_FOLLOWS = 'home.follows'
export const HOME_GUARDED = 'home.guarded'
export const HOME_RECENT = 'home.recent'
export const ME_ROLES = 'me.roles'
/** Whether this person has unlocked chat: kept, so a confirmed person stays so offline. */
export const ME_CHAT_AGE = 'me.chatAge'
/**
 * The schedule lists an older build kept as documents. The store's upgrade
 * reads them once into the schedule set; nothing writes them now.
 */
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
/**
 * The people Add Existing Player has found for a team, gathered from every
 * search's answer, so the scoring screen lists them at once and offline.
 */
export const candidatesKey = (teamId: string): string => `candidates.${teamId}`

/** How many found people a team's candidates document keeps. */
export const CANDIDATES_KEPT = 500

/** The team a search of `GET /users?forTeam=` is for, or none. */
export function candidatesTeamOf(path: string): string | undefined {
  if (!path.startsWith('/users?')) return undefined
  const team = new URLSearchParams(path.slice('/users?'.length)).get('forTeam')
  return team == null || team === '' ? undefined : team
}

/** Requests with no id in them, by path and query exactly as sent. */
const FIXED: Record<string, string> = {
  '/me/home': HOME_LISTS,
  '/teams': HOME_TEAMS,
  '/seasons': HOME_SEASONS,
  '/me/groups': HOME_GROUPS,
  '/me/follows': HOME_FOLLOWS,
  '/users?guardedBy=me': HOME_GUARDED,
  '/events?played=1&limit=1': HOME_RECENT,
  '/me/roles': ME_ROLES,
  '/me/account/chat-age': ME_CHAT_AGE
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

/**
 * GETs that are never stored, by path without the query: a session, a
 * clock, a stream or its address, and chat's own sync state.
 */
const NETWORK_ONLY: RegExp[] = [
  // A stored session answer would sign the phone in as whoever was stored.
  /^\/auth(\/|$)/,
  /^\/(health|time)$/,
  // A stored live list would offer a stream the phone cannot play.
  /^\/live(\/|$)/,
  /^\/me\/(builds|api-keys)(\/|$)/,
  // The address expires, and the stream does not play offline.
  /^\/videos\/[^/]+\/(playback|wall-timeline)$/,
  /^\/games\/[^/]+\/scoreboard-timeline$/,
  /^\/games\/[^/]+\/(live-streams|stream-access)(\/|$)/
]

/**
 * Chat's reads that are a screen: the conversation list and a conversation's
 * messages. Every other chat GET is the engine's keys and cursors, and a
 * stored page returned as fresh would skip messages.
 */
const CHAT_STORED = [
  /^\/chat\/conversations$/,
  /^\/chat\/conversations\/[^/]+\/messages$/
]

/** Whether a GET of `path` stays a network read, whatever it answers. */
export function networkOnly(path: string): boolean {
  const at = path.indexOf('?')
  const pathname = at < 0 ? path : path.slice(0, at)
  if (pathname === '/chat' || pathname.startsWith('/chat/'))
    return !CHAT_STORED.some(pattern => pattern.test(pathname))
  return NETWORK_ONLY.some(pattern => pattern.test(pathname))
}

/**
 * The document a GET of `path` fills: its short key, else the path itself,
 * or none for a read on the denylist.
 */
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
  return networkOnly(path) ? undefined : path
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
