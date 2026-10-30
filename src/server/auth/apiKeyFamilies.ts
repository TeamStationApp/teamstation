import type { ApiKeyArea, ApiKeyPermission } from '../../common/apiKeys'

/**
 * What a user API key may call: every route of the API, by family, and
 * nothing else. A key holding `<area>:read` may send `GET` and `HEAD` to its
 * area's routes; `<area>:write` may send `POST`, `PUT`, `PATCH` and `DELETE`.
 * Each entry is `METHOD path` in the OpenAPI spelling, below `/api/v1`, and
 * `apiKeyFamilies.test.ts` holds every entry to a route the server mounts.
 *
 * Left out on purpose, so a key is refused them: the password, deleting the
 * account, catalog pictures, onboarding, follows, notifications, invites,
 * join codes, people-role management, venues, locations, parent links,
 * relationship requests, live streams, video and media, the Director and its
 * uploads, device event control, node administration, walk-up songs,
 * narrations, chat, Tess, OAuth approvals, and the account's own API keys.
 */
export const API_KEY_FAMILIES: Record<ApiKeyArea, readonly string[]> = {
  account: [
    'GET /me/account',
    'PUT /me/account/name',
    'PUT /me/account/photo',
    'DELETE /me/account/photo',
    'POST /me/account/emails/request',
    'POST /me/account/emails/confirm',
    'PUT /me/account/emails/primary',
    'GET /me/groups',
    'GET /me/roles',
    'DELETE /me/groups/{kind}/{id}',
    'DELETE /me/groups/{kind}/{id}/roles/{role}'
  ],
  league: [
    'GET /leagues',
    'POST /leagues',
    'GET /leagues/{id}',
    'PUT /groups/league/{id}'
  ],
  season: [
    'GET /seasons',
    'POST /seasons',
    'GET /seasons/{id}',
    'GET /seasons/{seasonId}/teams',
    'PUT /groups/season/{id}'
  ],
  team: [
    'GET /teams',
    'POST /teams',
    'GET /teams/{id}',
    'PUT /groups/team/{id}',
    'PUT /teams/{teamId}/logo'
  ],
  gameEvents: [
    // The scoring log. `/events` alone is the calendar, under schedule.
    'GET /games/{gameId}/events',
    'POST /games/{gameId}/events',
    'PATCH /games/{gameId}/events',
    'GET /games/{gameId}/box-score',
    'GET /games/{gameId}/line-score',
    'GET /scoreboard/{gameId}',
    'GET /scoreboard/{gameId}/dashboard',
    'GET /games/{gameId}/scoreboard-overlay',
    'GET /games/{gameId}/scoreboard-timeline',
    'GET /games/{gameId}/halves',
    'POST /games/{gameId}/swap-sides',
    'GET /games/{gameId}/lineups',
    'POST /games/{gameId}/lineups',
    'GET /teams/{teamId}/default-lineup',
    'POST /games/{gameId}/guest-players',
    'PUT /games/{gameId}/unroster',
    'PUT /events/{id}/rsvps/{userId}',
    'GET /teams/{teamId}/roster',
    'POST /teams/{teamId}/roster-players',
    'POST /teams/{teamId}/players',
    // A player's page and the full name, as the roster's people; GraphQL
    // reads them for its players.
    'GET /players/{userId}',
    'GET /players/{userId}/name',
    'GET /teams/{teamId}/stats',
    'GET /players/{userId}/stats',
    'GET /players/{userId}/plays',
    'GET /seasons/{seasonId}/stats',
    'GET /seasons/{seasonId}/standings',
    'PUT /teams/{teamId}/players/{userId}/settings',
    'PUT /players/{userId}/settings',
    'GET /tags',
    'PUT /games/{gameId}/tags/{targetId}',
    'DELETE /games/{gameId}/tags/{targetId}'
  ],
  schedule: [
    'GET /teams/{teamId}/games',
    'GET /seasons/{seasonId}/games',
    'GET /games/{gameId}',
    'GET /games/{gameId}/scheduling',
    'GET /game-requests',
    'GET /events',
    'GET /events/{id}/info',
    'GET /events/{id}/location',
    'GET /leagues/{leagueId}/games-to-reschedule',
    'GET /schedule-previews/{previewId}',
    'GET /seasons/{seasonId}/schedule-settings',
    'GET /leagues/{leagueId}/schedule-setup',
    'POST /teams/{teamId}/games',
    'PUT /games/{gameId}/field',
    'POST /events',
    'PUT /events/{id}/info',
    'POST /game-requests',
    'POST /game-requests/{id}/withdraw',
    'POST /game-requests/{id}/resend',
    'DELETE /game-requests/{id}/schedule-entry',
    'POST /games/{gameId}/withdrawals',
    'POST /leagues/{leagueId}/schedule-previews',
    'PUT /schedule-previews/{previewId}',
    'POST /schedule-previews/{previewId}/publications',
    'PUT /seasons/{seasonId}/schedule-settings',
    'PUT /leagues/{leagueId}/schedule-setup'
  ],
  umpire: [
    'GET /leagues/{leagueId}/umpire-settings',
    'PUT /leagues/{leagueId}/umpire-settings',
    'GET /leagues/{leagueId}/umpire-types',
    'POST /leagues/{leagueId}/umpire-types',
    'DELETE /leagues/{leagueId}/umpire-types/{typeId}',
    'GET /leagues/{leagueId}/umpire-levels',
    'POST /leagues/{leagueId}/umpire-levels',
    'DELETE /leagues/{leagueId}/umpire-levels/{levelId}',
    'GET /leagues/{leagueId}/umpire-requirements',
    'PUT /leagues/{leagueId}/umpire-requirements',
    'GET /leagues/{leagueId}/umpire-candidates',
    'GET /leagues/{leagueId}/umpires',
    'PUT /leagues/{leagueId}/umpires',
    'POST /leagues/{leagueId}/umpires',
    'DELETE /leagues/{leagueId}/umpires/{userId}',
    'PUT /leagues/{leagueId}/umpires/{userId}/certifications',
    'GET /leagues/{leagueId}/umpire-schedule',
    'GET /leagues/{leagueId}/umpire-leaderboard',
    'GET /leagues/{leagueId}/umpire-note-types',
    'POST /leagues/{leagueId}/umpire-note-types',
    'DELETE /leagues/{leagueId}/umpire-note-types/{typeId}',
    'PUT /games/{gameId}/umpire-notes/{typeId}',
    'POST /games/{gameId}/umpire-slots',
    'DELETE /games/{gameId}/umpire-slots',
    'GET /me/umpire-leagues'
  ]
}

/**
 * Literal paths a `{param}` entry above would otherwise catch: `/teams/search`
 * is the follows search, not a team.
 */
const NEVER: readonly string[] = ['GET /teams/search']

/**
 * Routes a key may call with any read it holds. GraphQL is one: each field
 * is then read from its own REST route, which asks that field's family.
 */
export const ANY_READ: readonly string[] = ['POST /graphql']

/** Routes any key may call, whatever it holds: they ignore the key. */
export const KEYLESS: readonly string[] = [
  'GET /health',
  'GET /time',
  'GET /openapi.json'
]

interface Entry {
  method: string
  pattern: RegExp
  area: ApiKeyArea | null
}

function entryOf(route: string, area: ApiKeyArea | null): Entry {
  const [method, path] = route.split(' ')
  const source = path
    .split('/')
    .map(segment =>
      /^\{[^}]+\}$/.test(segment)
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('/')
  return { method, pattern: new RegExp(`^${source}/?$`, 'i'), area }
}

const NEVER_ENTRIES = NEVER.map(route => entryOf(route, null))
const KEYLESS_ENTRIES = KEYLESS.map(route => entryOf(route, null))
const ANY_READ_ENTRIES = ANY_READ.map(route => entryOf(route, null))
const ENTRIES: Entry[] = (
  Object.entries(API_KEY_FAMILIES) as Array<[ApiKeyArea, readonly string[]]>
).flatMap(([area, routes]) => routes.map(route => entryOf(route, area)))

/** Read for `GET` and `HEAD`, write for anything else. */
function accessOf(method: string): 'read' | 'write' {
  return method === 'GET' || method === 'HEAD' ? 'read' : 'write'
}

/**
 * A key on `method path` (below `/api/v1`): `keyless` for a route that
 * ignores the key, `anyRead` for one any read permission opens, the
 * permission it needs, or null for a route no key may call.
 */
export function keyNeeds(
  method: string,
  path: string
): ApiKeyPermission | 'keyless' | 'anyRead' | null {
  const upper = method.toUpperCase()
  const asGet = upper === 'HEAD' ? 'GET' : upper
  const matches = (entry: Entry): boolean =>
    entry.method === asGet && entry.pattern.test(path)
  if (KEYLESS_ENTRIES.some(matches)) return 'keyless'
  if (ANY_READ_ENTRIES.some(matches)) return 'anyRead'
  if (NEVER_ENTRIES.some(matches)) return null
  const entry = ENTRIES.find(matches)
  if (entry?.area == null) return null
  return `${entry.area}:${accessOf(upper)}`
}
