import { PRIMARY_HOST } from '../primaryUrl'

/**
 * Which Sentry environment an event belongs to, from the host of the server
 * the build talks to: `production` for the product host, a development
 * seat's own name for one of its hosts (`develop2`), and `development` for
 * anything local — localhost, an IP address, or no host at all.
 */
export function sentryEnvironment(host: string | undefined): string {
  const name = (host ?? '').trim().toLowerCase().replace(/:\d+$/, '')
  if (name === '' || name === 'localhost' || name.endsWith('.local'))
    return 'development'
  if (/^[\d.]+$/.test(name) || name.includes(':') || name.startsWith('['))
    return 'development'
  if (name === PRIMARY_HOST) return 'production'
  return name.split('.')[0]
}

/** The host of a URL or authority, or `undefined` when it has none. */
export function hostOfUrl(url: string | undefined): string | undefined {
  if (url == null || url === '') return undefined
  const match = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(\[[^\]]+\]|[^/:?#]+)/i.exec(url)
  return match?.[1]
}
