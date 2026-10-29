/**
 * What Tess may never ask the API for, whatever the person she acts for may
 * do. Both of her tools check here first: `api_get` for
 * reads, and `confirmChange` before a change is even shown to be confirmed;
 * and the loopback checks again, on the path its URL normalizes to, before
 * anything is sent.
 *
 * Paths are the API's own, under `/api/v1`, written without that prefix
 * (`/teams/t1/games`). A refusal is a sentence the model reads as its tool's
 * error, so it can say why it cannot help.
 */

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** A path as the loopback sends it: under `/api/v1`, already checked. */
export interface ApiPath {
  /** The path below `/api/v1`, starting with `/`, exactly as it will be sent. */
  path: string
  /** Its query string, `?…`, or empty. */
  search: string
}

/**
 * Routes no tool may reach, for any method. These belong to a signed-in
 * person and never to a machine acting for them: signing in and out, OAuth
 * approvals, Tess herself, the dictation socket, the account's own settings
 * (deletion, password, addresses and name), its API keys and its first-run
 * setup, the key
 * the person's devices share for event control, and the link to test
 * builds. The server refuses each of them to Tess as well (`isMachine`);
 * listed here, she is told why without asking.
 */
const ANY_METHOD: readonly RegExp[] = [
  /^\/auth(\/|$)/,
  /^\/oauth(\/|$)/,
  /^\/me\/tess/,
  /^\/dictation(\/|$)/,
  /^\/me\/account/,
  /^\/me\/api-keys(\/|$)/,
  /^\/me\/onboarding(\/|$)/,
  /^\/me\/builds(\/|$)/,
  /^\/device-event-control(\/|$)/
]

/**
 * Routes that treat a machine acting for the person differently from the
 * person, and that Tess may still use, getting what a machine gets. Every
 * mounted route whose handler asks `activeHuman` or `isMachine` is either
 * denied above or listed here, and `denyList.test.ts` fails on one that is
 * neither.
 */
export const ALLOWED_PERSON_ROUTES: readonly string[] = [
  // City search: a machine gets the built-in catalogue, not Google's
  // suggestions, which are paid for per person.
  'GET /locations',
  'GET /locations/{id}'
]

/**
 * Writes that are live scoring or live video. A game's plays and its live
 * lineup state change only from the scoring screen; streams and the
 * Director's claims and uploads only from a camera.
 */
const WRITES: readonly RegExp[] = [
  // Gumbo plays, posted and rewritten.
  /^\/games\/[^/]+\/events(\/|$)/,
  // `saveSide` appends lineup plays to the game.
  /^\/games\/[^/]+\/lineups(\/|$)/,
  /^\/games\/[^/]+\/unroster(\/|$)/,
  /^\/games\/[^/]+\/guest-players(\/|$)/,
  // The scoring screen's home/away exchange, which rewrites the open
  // at-bat's lineups.
  /^\/games\/[^/]+\/swap-sides(\/|$)/,
  /^\/games\/[^/]+\/live-streams(\/|$)/,
  /^\/director(\/|$)/
]

/**
 * The writes under `/games/:gameId/` that are not scoring, and which Tess
 * may therefore propose. Every mounted write under a game is either matched
 * by `WRITES` or listed here, and `denyList.test.ts` fails on one that is
 * neither, so a new scoring route cannot slip through by being new.
 */
export const ALLOWED_GAME_WRITES: readonly string[] = [
  'DELETE /games/{gameId}/tags/{targetId}',
  'PUT /games/{gameId}/tags/{targetId}',
  'POST /games/{gameId}/umpire-slots',
  'DELETE /games/{gameId}/umpire-slots',
  'PUT /games/{gameId}/field',
  'PUT /games/{gameId}/umpire-notes/{typeId}',
  'POST /games/{gameId}/withdrawals'
]

/**
 * The path a tool was given, checked and split, or the reason it is refused.
 * It must be an absolute path below `/api/v1` (the prefix itself may be
 * written or left out), with no scheme, no `.` or `..` segment, no
 * backslash, no empty segment and nothing that decodes into one of those:
 * a URL drops a dot segment, `%2e` too, so `/me/./account` would reach
 * `/me/account` past every rule below.
 */
export function apiPathOf(raw: string): ApiPath | string {
  const text = raw.trim()
  if (!text.startsWith('/') || text.startsWith('//'))
    return 'Give a path under /api/v1, starting with /, such as /teams, not a URL'
  const hash = text.indexOf('#')
  const bare = hash < 0 ? text : text.slice(0, hash)
  const query = bare.indexOf('?')
  let path = query < 0 ? bare : bare.slice(0, query)
  const search = query < 0 ? '' : bare.slice(query)
  if (path === '/api/v1' || path.startsWith('/api/v1/'))
    path = path.slice('/api/v1'.length)
  if (path === '') path = '/'
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return 'That path is not correctly encoded'
  }
  if (
    // eslint-disable-next-line no-control-regex
    /[\\\u0000-\u001f\u007f]/.test(decoded) ||
    decoded.includes('..') ||
    decoded.split('/').includes('.') ||
    decoded.includes('//') ||
    /%2f|%5c/i.test(path)
  )
    return 'That path is not allowed'
  return { path, search }
}

/**
 * Why Tess may not send `method` to `path`, or null when she may. `path` is
 * the checked path from `apiPathOf`. Express matches routes without regard to
 * case and with one trailing slash, so the check does too.
 */
export function refusalOf(method: ApiMethod, path: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return 'That path is not correctly encoded'
  }
  const route = decoded.toLowerCase().replace(/\/$/, '')
  if (ANY_METHOD.some(rule => rule.test(route)))
    return 'Tess may not use sign-in, account, API key, device key, test build, OAuth, dictation or Tess routes. The person can do this themselves in the app.'
  if (method !== 'GET' && WRITES.some(rule => rule.test(route)))
    return 'Tess may not change live scoring, lineups during a game, live video or the Director. The person scores on the scoring screen.'
  return null
}

/**
 * The checked path, or the refusal, for one tool request: `apiPathOf` and
 * then `refusalOf`.
 */
export function checkApiRequest(
  method: ApiMethod,
  raw: string
): ApiPath | string {
  const checked = apiPathOf(raw)
  if (typeof checked === 'string') return checked
  return refusalOf(method, checked.path) ?? checked
}
