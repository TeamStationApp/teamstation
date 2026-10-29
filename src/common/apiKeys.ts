import { asArray, asObject, asString, asValue } from 'cleaners'

/**
 * API keys a person makes under Account. A key calls the same API the app
 * calls, as that person, within the families it was given: each family read,
 * write, or neither. Write always comes with read.
 */

/** The families a key may be given, in the order Account lists them. */
export const API_KEY_AREAS = [
  'account',
  'gameEvents',
  'schedule',
  'league',
  'season',
  'team',
  'umpire'
] as const
export type ApiKeyArea = (typeof API_KEY_AREAS)[number]
export type ApiKeyAccess = 'read' | 'write'
export type ApiKeyPermission = `${ApiKeyArea}:${ApiKeyAccess}`

/** Each family's row on Create API key. */
export const API_KEY_AREA_LABELS: Record<
  ApiKeyArea,
  { title: string; subtext?: string }
> = {
  account: {
    title: 'Account settings',
    subtext: 'Name, email, photo, and memberships'
  },
  gameEvents: {
    title: 'Game events',
    subtext: 'Scoring, roster, stats, and RSVPs'
  },
  schedule: {
    title: 'Schedule',
    subtext: 'View and create games and events'
  },
  league: { title: 'League details' },
  season: { title: 'Season details' },
  team: { title: 'Team details' },
  umpire: { title: 'Umpire management' }
}

/** The longest name a key may have. */
export const MAX_API_KEY_NAME = 80

/** How many keys one account may hold at once. */
export const MAX_API_KEYS = 20

/** How many keys one account may make in `API_KEY_CREATE_WINDOW_MIN` minutes. */
export const API_KEY_CREATES_PER_WINDOW = 10
export const API_KEY_CREATE_WINDOW_MIN = 15

const PERMISSIONS: readonly ApiKeyPermission[] = API_KEY_AREAS.flatMap(
  area => [`${area}:read`, `${area}:write`] as const
)

export function asApiKeyPermission(raw: unknown): ApiKeyPermission {
  return asValue(...PERMISSIONS)(raw)
}

/**
 * Each write with its read, every permission once, in Account's order.
 */
export function normalizePermissions(
  permissions: readonly ApiKeyPermission[]
): ApiKeyPermission[] {
  const held = new Set<ApiKeyPermission>()
  for (const permission of permissions) {
    held.add(permission)
    const [area, access] = permission.split(':') as [ApiKeyArea, ApiKeyAccess]
    if (access === 'write') held.add(`${area}:read`)
  }
  return PERMISSIONS.filter(permission => held.has(permission))
}

/** A key's name: trimmed, 1 to 80 characters. */
export function asApiKeyName(raw: unknown): string {
  const name = asString(raw).trim()
  if (name.length < 1 || name.length > MAX_API_KEY_NAME)
    throw new TypeError(
      `Give the key a name of 1 to ${MAX_API_KEY_NAME} characters`
    )
  return name
}

/** The body of `POST /me/api-keys`. */
export const asApiKeyCreate = asObject({
  name: asApiKeyName,
  permissions: (raw: unknown): ApiKeyPermission[] => {
    const permissions = normalizePermissions(asArray(asApiKeyPermission)(raw))
    if (permissions.length === 0)
      throw new TypeError('Give the key at least one permission')
    return permissions
  }
})
export type ApiKeyCreate = ReturnType<typeof asApiKeyCreate>

/** One key as Account lists it. */
export const asApiKey = asObject({
  id: asString,
  name: asString,
  /** Null when the server's secret changed since the key was made. */
  secret: (raw: unknown): string | null =>
    raw === null ? null : asString(raw),
  createdAt: asString,
  permissions: asArray(asApiKeyPermission)
})
export type ApiKey = ReturnType<typeof asApiKey>

export const asApiKeys = asObject({ keys: asArray(asApiKey) })

/** What Account shows of a secret: its first eight characters. */
export function secretPreview(secret: string | null): string {
  return secret == null ? 'Cannot be shown' : `${secret.slice(0, 8)}…`
}
