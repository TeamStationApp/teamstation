/**
 * Every screen has an address.
 *
 * The app was one URL: opening a game changed nothing you could copy, a
 * reload lost your place, and the browser's Back button left the app
 * altogether. The rule now is that **anything somebody could want to link to
 * is on the URL** — which screen, which tab, which filter, which video and
 * where in it — and nothing else is stored anywhere at all.
 *
 * Parsing and building live together so they cannot drift: a route that can be
 * read but not written is a Back button that goes somewhere else.
 */

export type When = 'upcoming' | 'past' | 'all'

export type Route =
  | { name: 'home' }
  | { name: 'videos'; when: When }
  | { name: 'schedule'; when: When }
  | { name: 'account' }
  | { name: 'team'; teamId: string; tab?: string }
  | { name: 'season'; seasonId: string; tab?: string; when?: When }
  | { name: 'league'; leagueId: string }
  | {
      name: 'game'
      gameId: string
      tab?: 'watch' | 'boxScore'
      videoId?: string
      /** Seconds into the video. The link somebody pastes into a group chat. */
      at?: number
    }
  | { name: 'signIn'; next?: string }

const WHENS = new Set<string>(['upcoming', 'past', 'all'])

function whenOf(raw: string | null, fallback: When): When {
  return raw != null && WHENS.has(raw) ? (raw as When) : fallback
}

/** `/games/g1?video=v1&t=734` → the game, the video, and where in it. */
export function parseRoute(path: string, search = ''): Route {
  const query = new URLSearchParams(search)
  const parts = path.split('/').filter(part => part !== '')
  if (parts.length === 0) return { name: 'home' }

  const head = parts[0]
  const id = parts[1]
  switch (head) {
    case 'videos':
      return { name: 'videos', when: whenOf(query.get('when'), 'past') }
    case 'schedule':
      // Past, like the videos list: both open on what has happened, and a
      // schedule address that said `upcoming` put the filter back every time
      // somebody followed one.
      return { name: 'schedule', when: whenOf(query.get('when'), 'past') }
    case 'account':
      return { name: 'account' }
    case 'sign-in':
      return { name: 'signIn', next: safeNext(query.get('next')) }
    case 'teams':
      if (id == null) return { name: 'home' }
      return { name: 'team', teamId: id, tab: query.get('tab') ?? undefined }
    case 'seasons':
      if (id == null) return { name: 'home' }
      return {
        name: 'season',
        seasonId: id,
        tab: query.get('tab') ?? undefined,
        when:
          query.get('when') == null
            ? undefined
            : whenOf(query.get('when'), 'past')
      }
    case 'leagues':
      if (id == null) return { name: 'home' }
      return { name: 'league', leagueId: id }
    case 'games': {
      if (id == null) return { name: 'home' }
      const at = Number(query.get('t'))
      return {
        name: 'game',
        gameId: id,
        tab: query.get('tab') === 'boxScore' ? 'boxScore' : 'watch',
        videoId: query.get('video') ?? undefined,
        at: Number.isFinite(at) && at > 0 ? at : undefined
      }
    }
    default:
      return { name: 'home' }
  }
}

/** The address of a route, ready for the history. */
export function routePath(route: Route): string {
  switch (route.name) {
    case 'home':
      return '/'
    case 'videos':
      return route.when === 'past' ? '/videos' : `/videos?when=${route.when}`
    case 'schedule':
      return route.when === 'past'
        ? '/schedule'
        : `/schedule?when=${route.when}`
    case 'account':
      return '/account'
    case 'team':
      return route.tab == null
        ? `/teams/${route.teamId}`
        : `/teams/${route.teamId}?tab=${route.tab}`
    case 'season': {
      const bits: string[] = []
      if (route.tab != null) bits.push(`tab=${route.tab}`)
      if (route.when != null) bits.push(`when=${route.when}`)
      return bits.length === 0
        ? `/seasons/${route.seasonId}`
        : `/seasons/${route.seasonId}?${bits.join('&')}`
    }
    case 'league':
      return `/leagues/${route.leagueId}`
    case 'game': {
      const query = new URLSearchParams()
      if (route.tab === 'boxScore') query.set('tab', 'boxScore')
      if (route.videoId != null) query.set('video', route.videoId)
      if (route.at != null) query.set('t', String(Math.round(route.at)))
      const text = query.toString()
      return text === ''
        ? `/games/${route.gameId}`
        : `/games/${route.gameId}?${text}`
    }
    case 'signIn':
      return route.next == null
        ? '/sign-in'
        : `/sign-in?next=${encodeURIComponent(route.next)}`
  }
}

/**
 * A `next` is a path on this site and nothing else.
 *
 * Without this it is an open redirect: `/sign-in?next=//evil.example` reads as
 * a protocol-relative URL and sends somebody who has just typed their password
 * to another site. One leading slash, and never two.
 */
export function safeNext(raw: string | null | undefined): string | undefined {
  if (raw == null || raw === '') return undefined
  if (!raw.startsWith('/')) return undefined
  if (raw.startsWith('//')) return undefined
  if (raw.includes('\\')) return undefined
  return raw
}
