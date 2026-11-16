import type { PreferenceStorage } from '../scoring/scoringPreferenceStore'

/**
 * A develop build's own choice of server, kept on the device for its next
 * fresh launch, so one build can be pointed at any end-to-end stack. A stable
 * build never reads or writes one: the control is not shown there, and the
 * link that sets it is refused.
 *
 * It takes effect only when the app next starts: nothing switches the client
 * over while the app runs, so the launch a test exercises is the ordinary one.
 */
export const SERVER_KEY = 'server.origin'

/** The link host every develop build names as its app (Masonfile.ts). */
export const DEVELOP_APP_ORIGIN = 'https://develop.teamstation.app'

/** The develop phone app's test-control scheme; the TV's is `teamstationtv-develop`. */
export const DEVELOP_SCHEME = 'teamstation-develop'

/** Whether this build is a develop build, by the app origin it was built with. */
export function isDevelopBuild(appOrigin: string | undefined): boolean {
  return appOrigin === DEVELOP_APP_ORIGIN
}

/** `https://<host>` for a host name alone, or undefined: no path, no port, no other scheme. */
export function serverOriginOf(text: string): string | undefined {
  const value = text.trim().toLowerCase()
  const host = value.startsWith('https://')
    ? value.slice('https://'.length)
    : value
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return undefined
  return `https://${host}`
}

/** The override this develop build keeps, or undefined for none (or a stable build). */
export async function loadServerOverride(
  storage: PreferenceStorage,
  appOrigin: string | undefined
): Promise<string | undefined> {
  if (!isDevelopBuild(appOrigin)) return undefined
  const stored = await storage.getItem(SERVER_KEY).catch(() => null)
  return stored == null ? undefined : serverOriginOf(stored)
}

/** Keeps `origin` for the next launch, or forgets the override for null. Answers the host kept. */
export async function saveServerOverride(
  storage: PreferenceStorage,
  appOrigin: string | undefined,
  origin: string | null
): Promise<string | null> {
  if (!isDevelopBuild(appOrigin)) {
    throw new Error('Only a develop build can be pointed at another server')
  }
  if (origin == null) {
    // An empty value reads as none, where the storage cannot remove.
    if (storage.removeItem == null) await storage.setItem(SERVER_KEY, '')
    else await storage.removeItem(SERVER_KEY)
    return null
  }
  const valid = serverOriginOf(origin)
  if (valid == null) throw new Error(`${origin} is not a server's host name`)
  await storage.setItem(SERVER_KEY, valid)
  return new URL(valid).host
}

/**
 * The server a `teamstation-develop://server?origin=https://<host>` (or
 * `?clear=1`) link asks for: `{ origin }`, `{ origin: null }` to clear, or
 * undefined when the link is something else.
 */
export function serverLinkOf(
  url: string | null | undefined
): { origin: string | null } | undefined {
  if (url?.startsWith(`${DEVELOP_SCHEME}://server`) !== true) return undefined
  const query = new URL(url.replace(`${DEVELOP_SCHEME}://`, 'https://link/'))
    .searchParams
  if (query.get('clear') === '1') return { origin: null }
  const origin = query.get('origin')
  return origin == null ? undefined : { origin }
}

/** The API base the app talks to: the override's when there is one, the built one otherwise. */
export function apiBaseFor(
  override: string | undefined,
  built: string
): string {
  return override == null ? built : `${override}/api/v1`
}
