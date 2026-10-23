import { errorStatus, HttpError } from '../errors'
import type { EventName, Property } from './contract'

export type AnalyticsSink = (
  event: EventName,
  properties: Record<string, Property>
) => void

/** Closed route catalog. Bodies, URLs, search terms and invite codes never reach a sink. */
export async function observeApi<T>(
  method: string,
  path: string,
  work: () => Promise<T>,
  capture?: () => AnalyticsSink
): Promise<T> {
  let sink: AnalyticsSink | undefined
  try {
    sink = capture?.()
  } catch {}
  const send: AnalyticsSink = (event, properties) => {
    try {
      sink?.(event, properties)
    } catch {}
  }
  const route = path.split('?')[0]
  const group =
    /^\/(teams|seasons|leagues)(?:\/((?:tem|sea|lea)_[A-Za-z0-9_-]{1,96}))?$/.exec(
      route
    )
  const follow =
    /^\/me\/follows\/(team|season|league)\/((?:tem|sea|lea)_[A-Za-z0-9_-]{1,96})$/.exec(
      route
    )
  const invite = /^\/join\/[^/]+\/redeem$/.test(route) && method === 'POST'
  const join = /^\/join\/[^/]+\/email-code$/.test(route) && method === 'POST'
  const createEvent =
    ['/events', '/game-requests'].includes(route) && method === 'POST'
  const playback = /^\/videos\/vid_[A-Za-z0-9_-]{1,96}\/playback$/.test(route)
  const op =
    follow != null
      ? 'follow'
      : invite
        ? 'invite'
        : join
          ? 'join'
          : createEvent || (group != null && method === 'POST')
            ? 'create'
            : group != null
              ? 'search'
              : playback
                ? 'playback'
                : undefined
  const kind =
    group?.[1] === 'teams'
      ? 'team'
      : group?.[1] === 'seasons'
        ? 'season'
        : 'league'
  if (join || invite) send('join_requested', {})
  let result: T
  try {
    result = await work()
  } catch (error) {
    if (op != null) {
      const code = error instanceof HttpError ? error.code : 'internal'
      const status = errorStatus[code]
      send('api_failed', {
        op,
        ec:
          code === 'offline'
            ? 'offline'
            : code === 'rateLimited'
              ? 'rate_limited'
              : status < 500
                ? 'invalid'
                : 'internal',
        ...(status === 0 ? {} : { status })
      })
    }
    throw error
  }
  const data =
    result != null && typeof result === 'object'
      ? (result as Record<string, unknown>)
      : {}
  const entityId = (value: unknown): Record<string, Property> =>
    typeof value === 'string' &&
    /^(?:tem|sea|lea|gam)_[A-Za-z0-9_-]{1,96}$/.test(value)
      ? { id: value }
      : {}
  if (follow != null && ['PUT', 'DELETE'].includes(method))
    send('follow_changed', {
      id: follow[2],
      ty: follow[1],
      ok: method === 'PUT'
    })
  if (group != null) {
    if (method === 'GET' && group[2] != null)
      send('group_viewed', { id: group[2], ty: kind })
    if (method === 'GET' && /[?&]query=/.test(path) && Array.isArray(result))
      send('search_submitted', { n: Math.min(1000000, result.length) })
    if (method === 'POST')
      send('group_created', { ty: kind, ...entityId(data.id), ok: true })
  }
  if (invite) send('invite_accepted', { ok: true })
  // A submitted approval request may have no game yet. Count creation only
  // when the response confirms a committed game, never its proposed ID.
  if (
    createEvent &&
    (route === '/events' ||
      (data.status === 'accepted' && typeof data.gameId === 'string'))
  )
    send('event_created', {
      ty: 'game',
      ...entityId(data.gameId ?? data.id),
      ok: true
    })
  return result
}
