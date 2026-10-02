/**
 * The two scoreboard pages, which are not screens of the app.
 *
 * `/scoreboard/<gameId>` is the live board, with no sign-in, for OBS or TS
 * Director to draw over video; `?quiet=1` draws nothing, rather than the
 * branded 404, once the board has closed, which is what a programme wants.
 * `/scoreboard-sample` is the same box with fixed demo values, for placing it.
 */
export type ScoreboardPageKind =
  { kind: 'sample' } | { kind: 'live'; gameId: string; quiet: boolean }

export function scoreboardPageFor(
  pathname: string,
  search: string
): ScoreboardPageKind | undefined {
  const parts = pathname.split('/').filter(part => part !== '')
  if (parts.length === 1 && parts[0] === 'scoreboard-sample') {
    return { kind: 'sample' }
  }
  if (parts.length === 2 && parts[0] === 'scoreboard') {
    return {
      kind: 'live',
      gameId: decodeURIComponent(parts[1]),
      quiet: new URLSearchParams(search).get('quiet') === '1'
    }
  }
  return undefined
}

/** The part of `window.location` a socket address is built from. */
export interface PageOrigin {
  protocol: string
  host: string
}

/**
 * A game's scoreboard socket, beside the API.
 *
 * The API base is `/api/v1` in production, the page's own origin, and an
 * absolute `http://127.0.0.1:9100/api/v1` under `npm run start.web`, where
 * the API is another port. Either way `http` becomes `ws` and `https`
 * becomes `wss`. `path` is the viewer's `socket` unless the dashboard asks
 * for its own.
 */
export function socketUrlFor(
  location: PageOrigin | undefined,
  apiBaseUrl: string,
  gameId: string,
  path: 'socket' | 'dashboard' = 'socket'
): string {
  let base = apiBaseUrl.replace(/\/+$/, '')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) {
    if (location == null) {
      throw new Error(`No origin to resolve ${apiBaseUrl} against`)
    }
    base = `${location.protocol}//${location.host}${base.startsWith('/') ? '' : '/'}${base}`
  }
  return `${base.replace(/^http(s?):/i, 'ws$1:')}/scoreboard/${encodeURIComponent(gameId)}/${path}`
}
