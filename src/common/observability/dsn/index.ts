/**
 * What a public routing DSN names, and nothing else: `https://<key>@<host>/<project>`.
 *
 * One rule for the clients that send to the collector (`logger.ts`) and the
 * web build that has to let them (`buildCsp.mjs`). This file imports nothing
 * and uses only type syntax Node can strip, because the build loads it as it
 * is, without a compiler.
 */

/** The collector's ingestion URL for a DSN, or undefined for anything else. */
export function logEndpoint(dsn: string): string | undefined {
  try {
    const url = new URL(dsn)
    if (
      url.protocol !== 'https:' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(url.username) ||
      !/^\/[0-9]{1,20}$/.test(url.pathname)
    )
      return undefined
    return url.origin + '/ingest' + url.pathname
  } catch {
    return undefined
  }
}

/** The collector's origin for a DSN, for a page's `connect-src`. */
export function logOrigin(dsn: string | undefined): string | undefined {
  if (dsn == null || dsn === '') return undefined
  const endpoint = logEndpoint(dsn)
  return endpoint == null ? undefined : new URL(endpoint).origin
}
